/**
 * Process-level integration tests for the RFC §16.1 step-1 remainder:
 * stdio entry, single shared broker, named-pipe startup/lifetime mutex,
 * authenticated handshake, heartbeat, grace-period exit, and recovery
 * storage — exercised against the REAL built artifacts (dist/entry.mjs,
 * dist/broker.mjs) with a fake bridge process.
 *
 * All scenarios live in this single file on purpose: they share the
 * per-user named pipes, so they must run sequentially. Each scenario uses
 * its own port/stateDir and cleans up its broker explicitly.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import net from "node:net";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { LIMITS } from "../../src/protocol/limits.ts";
import { RecoveryFileSchema } from "../../src/protocol/recovery.ts";
import { parseMessage } from "../../src/protocol/envelope.ts";
import { Broker } from "../../src/broker/server.ts";
import { loadRuntimeConfig } from "../../src/cli/config.ts";
import { ensureCredentials } from "../../src/cli/credentials.ts";
import { brokerPipeNames, probeLifetimePipe, serveLifetimeDiscovery } from "../../src/broker/pipes.ts";
import { WebSocketServer } from "ws";
import { RecoveryStore, RecoveryWriteError } from "../../src/broker/recovery-store.ts";

const MCP_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRY_ARTIFACT = join(MCP_ROOT, "dist", "entry.mjs");
const BROKER_ARTIFACT = join(MCP_ROOT, "dist", "broker.mjs");
const FAKE_BRIDGE = join(MCP_ROOT, "tests", "process", "fixtures", "fake-bridge.ts");

test("pending dispatch intent blocks status and wrong bound UUIDs never reach control handlers", async () => {
  const scenario = await makeScenario("bound-identity");
  const taskId = randomUUID();
  const brokerInstanceId = randomUUID();
  writeFileSync(join(scenario.stateDir, "recovery.json"), JSON.stringify(RecoveryFileSchema.parse({
    version: 1, brokerInstanceId, history: [], pending: {
      kind: "dispatch_intent", taskId, brokerInstanceId, target: { side: "server" },
      environment: { bridgeEpoch: randomUUID(), serverPid: 2147483647, serverStartedAt: "2000-01-01T00:00:00.000Z", serverIdentityVerifiable: false },
      toolCategory: "execution", createdAt: new Date().toISOString(),
    },
  })));
  const entry = spawnEntry(scenario);
  try {
    await entry.mcp.initialize();
    const status = await awaitStatusOk(entry.mcp);
    assert.equal(status.dispatchBlocked, true);
    assert.equal((status.recovery as Record<string, unknown>).pendingTaskId, taskId);
    assert.equal((status.queue as Record<string, unknown>).runningOrUnknown, 1);
    for (const badField of ["sessionId", "brokerInstanceId", "role", "hello"]) {
      const ws = new WebSocket(`ws://127.0.0.1:${scenario.port}/internal/v1/entry`, { headers: { Authorization: `Bearer ${scenario.entryToken}` } });
      const welcome = await new Promise<{ brokerInstanceId: string; sessionId: string }>((resolve, reject) => {
        const timer = setTimeout(() => { ws.terminate(); reject(new Error("welcome timeout")); }, 5000);
        ws.on("open", () => ws.send(JSON.stringify({ v: 1, id: randomUUID(), type: "hello", payload: { role: "entry", internalProtocol: 1, buildId: "fiveai-mcp/0.1.0", configDigest: status.configDigest } })));
        ws.once("message", data => { clearTimeout(timer); resolve(JSON.parse(String(data)).payload); });
        ws.on("error", reject);
      });
      let handled = false;
      ws.on("message", data => { if (JSON.parse(String(data)).type === "control.result") handled = true; });
      const closed = expectClose(ws, 1500);
      const invalidMessage = { v: 1, id: randomUUID(), brokerInstanceId: welcome.brokerInstanceId, sessionId: welcome.sessionId,
        ...(badField === "sessionId" || badField === "brokerInstanceId" ? { [badField]: randomUUID() } : {}),
        type: badField === "role" ? "clients.snapshot" : badField === "hello" ? "hello" : "control.request",
        payload: badField === "role" ? { bridgeEpoch: randomUUID(), clients: [] } : badField === "hello" ? { role: "entry", internalProtocol: 1, buildId: "fiveai-mcp/0.1.0", configDigest: status.configDigest } : { requestId: randomUUID(), tool: "status", arguments: {} },
      };
      parseMessage(invalidMessage); // Valid schema; rejection must be connection-bound.
      ws.send(JSON.stringify(invalidMessage));
      assert.equal((await closed).code, 4007);
      assert.equal(handled, false);
    }
  } finally { killTree(entry.child); await killBroker(scenario); rmSync(scenario.dir, { recursive: true, force: true }); }
});

interface Scenario {
  name: string;
  dir: string;
  configPath: string;
  stateDir: string;
  port: number;
  entryToken: string;
  bridgeToken: string;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as net.AddressInfo;
      const port = address.port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

async function makeScenario(name: string): Promise<Scenario> {
  const dir = join(tmpdir(), `fiveai-proc-${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(dir, "state"), { recursive: true });
  mkdirSync(join(dir, "logs"), { recursive: true });
  const port = await freePort();
  const configPath = join(dir, "config.json");
  const credsPath = join(dir, "creds.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      broker: { host: "127.0.0.1", port },
      stateDir: join(dir, "state").replace(/\//g, "\\"),
      credentialFile: credsPath.replace(/\//g, "\\"),
      clientLogDir: join(dir, "logs").replace(/\//g, "\\"),
      serverLabel: `proc-${name}`,
    }),
  );
  // Credentials must meet the access boundary the entry verifies
  // (unified-artifact RFC §5): generate them through the real initializer
  // instead of a plain write with inherited permissions.
  const credentials = await ensureCredentials(credsPath.replace(/\//g, "\\"));
  return { name, dir, configPath, stateDir: join(dir, "state"), port, entryToken: credentials.entryToken, bridgeToken: credentials.bridgeToken };
}

/** Minimal MCP stdio client driving a spawned entry. */
class McpClient {
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void }>();

  private readonly child: ChildProcess;

  constructor(child: ChildProcess) {
    this.child = child;
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      let index: number;
      while ((index = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        if (line.trim() === "") continue;
        try {
          const message = JSON.parse(line) as { id?: number };
          if (typeof message.id === "number" && this.pending.has(message.id)) {
            this.pending.get(message.id)!.resolve(message);
            this.pending.delete(message.id);
          }
        } catch {
          // Non-JSON noise; entries keep stdout protocol-clean.
        }
      }
    });
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as Record<string, unknown>);
        },
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  notify(method: string): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  async initialize(): Promise<void> {
    const response = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fiveai-proc-test", version: "0" },
    });
    if (response.error !== undefined) {
      throw new Error(`initialize failed: ${JSON.stringify(response.error)}`);
    }
    this.notify("notifications/initialized");
  }

  async callStatus(arguments_: Record<string, unknown> = {}): Promise<{ isError: boolean; structuredContent: Record<string, unknown> }> {
    const response = (await this.request("tools/call", { name: "status", arguments: arguments_ })) as {
      result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    };
    return {
      isError: response.result?.isError === true,
      structuredContent: response.result?.structuredContent ?? {},
    };
  }
}

interface RuntimeRecord {
  pid: number;
  brokerInstanceId: string;
  configDigest: string;
}

function readRuntime(scenario: Scenario): RuntimeRecord | null {
  const path = join(scenario.stateDir, "runtime.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RuntimeRecord;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  label: string,
  intervalMs = 200,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.ok(predicate(), `${label} (waited ${timeoutMs}ms)`);
}

function spawnEntry(scenario: Scenario): { child: ChildProcess; mcp: McpClient } {
  const child = spawn(process.execPath, [ENTRY_ARTIFACT, "--config", scenario.configPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { child, mcp: new McpClient(child) };
}

/** Wait until a status call succeeds (broker link established). */
async function awaitStatusOk(mcp: McpClient, timeoutMs = 30_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await mcp.callStatus();
    if (!result.isError) return result.structuredContent;
    if (Date.now() >= deadline) {
      assert.ok(false, `status never succeeded: ${JSON.stringify(result.structuredContent)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function killTree(child: ChildProcess): void {
  try {
    child.kill();
  } catch {
    // Already gone.
  }
}

async function killBroker(scenario: Scenario): Promise<void> {
  // A broker may still be mid-startup: wait for runtime.json before
  // deciding there is nothing to kill, so no detached broker leaks past
  // the scenario and poisons the shared lifetime pipe.
  const appearDeadline = Date.now() + 10_000;
  let runtime = readRuntime(scenario);
  while (runtime === null && Date.now() < appearDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime = readRuntime(scenario);
  }
  if (runtime === null) return;
  if (pidAlive(runtime.pid)) {
    try {
      process.kill(runtime.pid);
    } catch {
      // Racing exit is fine.
    }
    const exitDeadline = Date.now() + 10_000;
    while (pidAlive(runtime.pid) && Date.now() < exitDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function readBridgeStdout(child: ChildProcess): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  let buffer = "";
  let stderrBuffer = "";
  return new Promise((resolve) => {
    child.stdout!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // Ignore noise.
        }
      }
    });
    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      let index: number;
      while ((index = stderrBuffer.indexOf("\n")) !== -1) {
        const line = stderrBuffer.slice(0, index);
        stderrBuffer = stderrBuffer.slice(index + 1);
        if (line.trim() !== "") events.push({ event: "stderr", line });
      }
    });
    // Resolve with a live view the caller can inspect over time.
    resolve(events);
  });
}

function expectClose(ws: WebSocket, timeoutMs = 10_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("connection was not closed in time")), timeoutMs);
    ws.on("close", (code: number, reason: Buffer) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
    ws.on("error", () => {
      // The close event follows.
    });
  });
}

test("stdio chain: initialize, tools/list, and a real tools/call status (RFC §16.1 step 1)", async () => {
  assert.ok(existsSync(ENTRY_ARTIFACT), `entry artifact exists: ${ENTRY_ARTIFACT}`);
  const scenario = await makeScenario("stdio");
  const { child, mcp } = spawnEntry(scenario);
  try {
    await mcp.initialize();
    const toolsResponse = (await mcp.request("tools/list", {})) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = toolsResponse.result?.tools?.map((tool) => tool.name) ?? [];
    // Only genuinely servable tools are registered (completeness review
    // step 2); the screenshot contract is excluded (RFC §14).
    assert.deepEqual(names, ["status"]);
    assert.equal(names.includes("screenshot"), false);

    const status = await awaitStatusOk(mcp);
    assert.equal(typeof status.brokerInstanceId, "string");
    assert.equal(status.buildId, "fiveai-mcp/0.1.0");
    assert.equal(status.internalProtocol, 1);
    assert.equal(status.shuttingDown, false);
    assert.equal(status.connectedEntries, 1);
    assert.equal(status.bridge, null);
    assert.deepEqual(status.registeredTools, ["status"]);
    assert.deepEqual(status.screenshot, { implemented: false, enabled: false });
    assert.equal(status.dispatchBlocked, false);
    // The ok-state recovery summary carries no code/message keys at all
    // (they only exist when something is wrong) — compare the JSON form.
    assert.deepEqual(
      JSON.parse(JSON.stringify(status.recovery)),
      { status: "ok", pendingTaskId: null, historyEntries: 0 },
    );
    assert.deepEqual((status.limits as Record<string, unknown>).queue, {
      maxQueued: LIMITS.queue.maxQueued,
      maxRunningOrUnknown: LIMITS.queue.maxRunningOrUnknown,
    });
    const runtime = readRuntime(scenario);
    assert.ok(runtime !== null, "runtime.json written");
    assert.equal(runtime.brokerInstanceId, status.brokerInstanceId);
    assert.ok(pidAlive(runtime.pid));
  } finally {
    killTree(child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("ten competing entries converge on exactly one broker (RFC §4.2)", async () => {
  const scenario = await makeScenario("compete");
  const entries: Array<{ child: ChildProcess; mcp: McpClient }> = [];
  try {
    for (let index = 0; index < 10; index += 1) {
      entries.push(spawnEntry(scenario));
    }
    const statuses: Array<Record<string, unknown>> = [];
    for (const { mcp } of entries) {
      await mcp.initialize();
      statuses.push(await awaitStatusOk(mcp));
    }
    const instanceIds = new Set(statuses.map((status) => status.brokerInstanceId));
    assert.equal(instanceIds.size, 1, "all entries share one brokerInstanceId");
    const runtime = readRuntime(scenario);
    assert.ok(runtime !== null);
    assert.ok(instanceIds.has(runtime.brokerInstanceId));
    // Exactly one broker process is alive for that instance id.
    assert.ok(pidAlive(runtime.pid));
    // Every entry finished its own handshake above; a fresh query now sees
    // the full session count (early per-entry statuses may legitimately
    // have observed fewer connected peers).
    const final = await entries[entries.length - 1]!.mcp.callStatus();
    assert.equal(final.isError, false);
    assert.equal(final.structuredContent.connectedEntries, 10);
  } finally {
    for (const { child } of entries) killTree(child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("a different configuration cannot create a second scheduler (RFC §4.2)", async () => {
  const scenarioA = await makeScenario("config-a");
  const scenarioB = await makeScenario("config-b");
  const entryA = spawnEntry(scenarioA);
  try {
    await entryA.mcp.initialize();
    await awaitStatusOk(entryA.mcp);
    const brokerA = readRuntime(scenarioA);
    assert.ok(brokerA !== null);

    const entryB = spawn(process.execPath, [ENTRY_ARTIFACT, "--config", scenarioB.configPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drive it as an MCP client so it proceeds to broker discovery.
    const mcpB = new McpClient(entryB);
    await mcpB.initialize();
    const exitInfo = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      entryB.stderr!.setEncoding("utf8");
      entryB.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
      });
      entryB.on("exit", (code) => resolve({ code, stderr }));
    });
    assert.equal(exitInfo.code, 3, `entry B exits with the broker-unavailable code; stderr: ${exitInfo.stderr}`);
    assert.match(exitInfo.stderr, /INSTANCE_CONFLICT/);
    // No second broker was ever created for config B...
    assert.equal(readRuntime(scenarioB), null, "config B never wrote runtime.json");
    // ...and broker A is untouched.
    const brokerAfter = readRuntime(scenarioA);
    assert.ok(brokerAfter !== null);
    assert.equal(brokerAfter.brokerInstanceId, brokerA.brokerInstanceId);
    assert.ok(pidAlive(brokerAfter.pid));
  } finally {
    killTree(entryA.child);
    await killBroker(scenarioA);
    rmSync(scenarioA.dir, { recursive: true, force: true });
    rmSync(scenarioB.dir, { recursive: true, force: true });
  }
});

test("wrong token, wrong role, browser origin, and bad host are rejected before any welcome", async () => {
  const scenario = await makeScenario("auth");
  const entry = spawnEntry(scenario);
  try {
    await entry.mcp.initialize();
    await awaitStatusOk(entry.mcp);

    const cases: Array<{ label: string; url: string; headers: Record<string, string>; family?: number }> = [
      {
        label: "wrong entry token",
        url: `ws://127.0.0.1:${scenario.port}/internal/v1/entry`,
        headers: { Authorization: `Bearer ${randomBytes(32).toString("base64")}` },
      },
      {
        label: "bridge token on the entry route",
        url: `ws://127.0.0.1:${scenario.port}/internal/v1/entry`,
        headers: { Authorization: `Bearer ${scenario.bridgeToken}` },
      },
      {
        label: "entry token on the bridge route",
        url: `ws://127.0.0.1:${scenario.port}/internal/v1/bridge`,
        headers: { Authorization: `Bearer ${scenario.entryToken}` },
      },
      {
        label: "browser origin",
        url: `ws://127.0.0.1:${scenario.port}/internal/v1/entry`,
        headers: { Authorization: `Bearer ${scenario.entryToken}`, Origin: "http://127.0.0.1:8080" },
      },
      {
        label: "host header mismatch",
        // family: 4 keeps the TCP target on loopback IPv4 while the Host
        // header says "localhost:<port>" instead of the pinned 127.0.0.1.
        url: `ws://localhost:${scenario.port}/internal/v1/entry`,
        headers: { Authorization: `Bearer ${scenario.entryToken}` },
        family: 4,
      },
      {
        label: "missing token",
        url: `ws://127.0.0.1:${scenario.port}/internal/v1/entry`,
        headers: {},
      },
    ];
    for (const testCase of cases) {
      const ws = new WebSocket(testCase.url, {
        headers: testCase.headers,
        ...(testCase.family === undefined ? {} : { family: testCase.family }),
      });
      let opened = false;
      let statusCode: number | undefined;
      ws.on("open", () => { opened = true; });
      ws.on("unexpected-response", (_request, response) => {
        statusCode = response.statusCode;
        response.resume();
        ws.terminate();
      });
      await expectClose(ws);
      assert.equal(opened, false, `${testCase.label}: must not upgrade`);
      assert.equal(statusCode, 401, `${testCase.label}: HTTP rejection`);
    }

    // A valid token that then sends garbage is closed as a protocol error.
    const garbage = new WebSocket(`ws://127.0.0.1:${scenario.port}/internal/v1/entry`, {
      headers: { Authorization: `Bearer ${scenario.entryToken}` },
    });
    await new Promise<void>((resolve) => garbage.once("open", () => resolve()));
    garbage.send("this is not json");
    const close = await expectClose(garbage);
    assert.equal(close.code, 4007);
  } finally {
    killTree(entry.child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("a fake bridge handshakes, surfaces in status, and blocks a second bridge", async () => {
  const scenario = await makeScenario("bridge");
  const entry = spawnEntry(scenario);
  let bridge: ChildProcess | null = null;
  let secondBridge: ChildProcess | null = null;
  try {
    await entry.mcp.initialize();
    await awaitStatusOk(entry.mcp);

    bridge = spawn(process.execPath, [
      FAKE_BRIDGE,
      "--url", `ws://127.0.0.1:${scenario.port}/internal/v1/bridge`,
      "--token", scenario.bridgeToken,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const events = await readBridgeStdout(bridge);
    await waitUntil(() => events.some((event) => event.event === "ready"), 10_000, "fake bridge ready");
    const ready = events.find((event) => event.event === "ready") as
      | { bridgeEpoch: string; brokerInstanceId: string }
      | undefined;
    assert.ok(ready !== undefined, "fake bridge reported ready");

    const status = await awaitStatusOk(entry.mcp);
    const bridgeStatus = status.bridge as
      | { environment: { bridgeEpoch: string; serverPid: number; serverIdentityVerifiable: boolean }; adapterDigest: string }
      | null;
    assert.ok(bridgeStatus !== null, "status shows the connected bridge");
    assert.equal(bridgeStatus.environment.bridgeEpoch, ready.bridgeEpoch);
    assert.equal(bridgeStatus.environment.serverPid, bridge.pid);
    assert.equal(bridgeStatus.environment.serverIdentityVerifiable, false, "a fixture's current timestamp is not its OS process creation time");
    assert.equal(bridgeStatus.adapterDigest, "fake-bridge-test");

    // A second bridge cannot displace the first (one server environment).
    secondBridge = spawn(process.execPath, [
      FAKE_BRIDGE,
      "--url", `ws://127.0.0.1:${scenario.port}/internal/v1/bridge`,
      "--token", scenario.bridgeToken,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const secondEvents = await readBridgeStdout(secondBridge);
    await waitUntil(
      () => secondEvents.some((event) => event.event === "close"),
      10_000,
      "second bridge rejected",
    );
    const close = secondEvents.find((event) => event.event === "close") as { code: number } | undefined;
    assert.equal(close!.code, 4004, "BRIDGE_ALREADY_CONNECTED");

    // The first bridge is unaffected and disconnecting clears the slot.
    killTree(bridge);
    bridge = null;
    const cleared = await (async () => {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const current = await entry.mcp.callStatus();
        if (!current.isError && current.structuredContent.bridge === null) return true;
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    })();
    assert.equal(cleared, true, "bridge slot cleared after disconnect");
  } finally {
    if (bridge !== null) killTree(bridge);
    if (secondBridge !== null) killTree(secondBridge);
    killTree(entry.child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("a silent bridge is closed after the heartbeat loss threshold (RFC §4.3)", async () => {
  const scenario = await makeScenario("heartbeat");
  const entry = spawnEntry(scenario);
  let bridge: ChildProcess | null = null;
  try {
    await entry.mcp.initialize();
    await awaitStatusOk(entry.mcp);
    bridge = spawn(process.execPath, [
      FAKE_BRIDGE,
      "--url", `ws://127.0.0.1:${scenario.port}/internal/v1/bridge`,
      "--token", scenario.bridgeToken,
      "--no-pong",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const events = await readBridgeStdout(bridge);
    await waitUntil(() => events.some((event) => event.event === "ready"), 10_000, "fake bridge ready");
    // lossAfterMs=15s from connection; allow generous margin.
    await waitUntil(
      () => events.some((event) => event.event === "close"),
      LIMITS.heartbeat.lossAfterMs + 15_000,
      "silent bridge closed by heartbeat loss",
      250,
    );
    const close = events.find((event) => event.event === "close") as { code: number; reason: string } | undefined;
    assert.equal(close!.code, 4006, "HEARTBEAT_LOST");
    assert.equal(close!.reason, "HEARTBEAT_LOST");
  } finally {
    if (bridge !== null) killTree(bridge);
    killTree(entry.child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("a corrupt recovery record surfaces STATE_STORE_ERROR and blocks dispatch", async () => {
  const scenario = await makeScenario("recovery");
  const corrupt = "{ not json at all";
  const recoveryPath = join(scenario.stateDir, "recovery.json");
  writeFileSync(recoveryPath, corrupt);
  const entry = spawnEntry(scenario);
  try {
    await entry.mcp.initialize();
    const status = await awaitStatusOk(entry.mcp);
    const recovery = status.recovery as { status: string; code?: string; message?: string };
    assert.equal(recovery.status, "corrupt");
    assert.equal(recovery.code, "STATE_STORE_ERROR");
    assert.equal(status.dispatchBlocked, true);
    assert.match(String(status.dispatchBlockedReason), /STATE_STORE_ERROR/);
    // The corrupt record is preserved, never cleared to "recover".
    assert.equal(readFileSync(recoveryPath, "utf8"), corrupt);
  } finally {
    killTree(entry.child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("an entry that dies abruptly is cleaned up by the broker (RFC §4.3)", async () => {
  const scenario = await makeScenario("cleanup");
  const first = spawnEntry(scenario);
  const second = spawnEntry(scenario);
  try {
    await first.mcp.initialize();
    await second.mcp.initialize();
    await awaitStatusOk(second.mcp);
    const before = await second.mcp.callStatus();
    assert.equal(before.isError, false);
    assert.equal(before.structuredContent.connectedEntries, 2);

    killTree(first.child);
    const deadline = Date.now() + 10_000;
    let after: { isError: boolean; connectedEntries?: number } = { isError: true };
    while (Date.now() < deadline) {
      const current = await second.mcp.callStatus();
      after = { isError: current.isError, connectedEntries: current.structuredContent.connectedEntries as number };
      if (!current.isError && current.structuredContent.connectedEntries === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(after.connectedEntries, 1, "broker dropped the dead entry's session");
  } finally {
    killTree(first.child);
    killTree(second.child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("a broker whose port is occupied by a foreign process exits PORT_IN_USE", async () => {
  const scenario = await makeScenario("port-busy");
  const squatter = net.createServer();
  await new Promise<void>((resolve) => squatter.listen(scenario.port, "127.0.0.1", () => resolve()));
  try {
    const broker = spawn(process.execPath, [BROKER_ARTIFACT, "--config", scenario.configPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    const { code, stderr } = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      broker.stderr!.setEncoding("utf8");
      broker.stderr!.on("data", (chunk: string) => {
        stderr += chunk;
      });
      broker.on("exit", (exitCode) => resolve({ code: exitCode, stderr }));
    });
    assert.equal(code, 3);
    assert.match(stderr, /PORT_IN_USE/);
    assert.equal(readRuntime(scenario), null, "no runtime.json without the port");
  } finally {
    squatter.close();
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("the broker exits after the grace period and a new generation can start (RFC §4.3)", async () => {
  const scenario = await makeScenario("grace");
  const first = spawnEntry(scenario);
  try {
    await first.mcp.initialize();
    const status = await awaitStatusOk(first.mcp);
    const firstInstance = status.brokerInstanceId as string;
    const runtime = readRuntime(scenario);
    assert.ok(runtime !== null);

    // Last entry disconnects: broker must exit within the grace period.
    killTree(first.child);
    await waitUntil(
      () => !pidAlive(runtime.pid),
      LIMITS.gracePeriodMs + 20_000,
      "broker exits after the grace period",
      500,
    );

    // After the old service is gone, a new entry starts a new generation.
    const second = spawnEntry(scenario);
    try {
      await second.mcp.initialize();
      const nextStatus = await awaitStatusOk(second.mcp);
      assert.notEqual(nextStatus.brokerInstanceId, firstInstance);
    } finally {
      killTree(second.child);
      await killBroker(scenario);
    }
  } finally {
    killTree(first.child);
    await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("grace reuse keeps the same broker and oversized frames cannot reach a handler", async () => {
  const scenario = await makeScenario("reuse-frame");
  const first = spawnEntry(scenario);
  let second: ReturnType<typeof spawnEntry> | undefined;
  try {
    await first.mcp.initialize();
    const before = await awaitStatusOk(first.mcp);
    killTree(first.child);
    await waitUntil(() => first.child.exitCode !== null || first.child.signalCode !== null, 5000, "first entry exits");
    second = spawnEntry(scenario);
    await second.mcp.initialize();
    assert.equal((await awaitStatusOk(second.mcp)).brokerInstanceId, before.brokerInstanceId);
    const ws = new WebSocket(`ws://127.0.0.1:${scenario.port}/internal/v1/entry`, { headers: { Authorization: `Bearer ${scenario.entryToken}` } });
    const closed = expectClose(ws);
    ws.on("open", () => ws.send("x".repeat(LIMITS.message.frameMaxBytes + 1)));
    assert.equal((await closed).code, 1009);
    assert.equal((await second.mcp.callStatus()).isError, false);
  } finally {
    killTree(first.child); if (second) killTree(second.child);
    await killBroker(scenario); rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("startup disk failure releases handles and shutdown retains the lifetime mutex until HTTP stops", async () => {
  const a = await makeScenario("shutdown-a");
  const b = await makeScenario("shutdown-b");
  const loaded = loadRuntimeConfig(a.configPath);
  // Change the directory after loading: startup must revalidate before writing.
  mkdirSync(join(a.stateDir, "runtime.json"));
  const failed = new Broker(loaded);
  const pipes = await brokerPipeNames();
  try {
    await assert.rejects(failed.start(), /regular file/);
    assert.equal((await probeLifetimePipe(pipes.lifetime)).status, "absent");
    const old = new Broker(loadRuntimeConfig(b.configPath));
    await old.start();
    const stopping = old.shutdown("test shutdown");
    const competitor = new Broker(loaded);
    await assert.rejects(competitor.start(), /lifetime pipe/);
    await stopping;
    assert.equal((await probeLifetimePipe(pipes.lifetime)).status, "absent");
    const port = net.createServer();
    await new Promise<void>((resolve, reject) => {
      port.once("error", reject);
      port.listen(b.port, "127.0.0.1", () => resolve());
    });
    await new Promise<void>(resolve => port.close(() => resolve()));
  } finally {
    await failed.shutdown("cleanup");
    rmSync(a.dir, { recursive: true, force: true }); rmSync(b.dir, { recursive: true, force: true });
  }
});

test("built entry rejects wrong identities and repeated welcome, then recovers after repeated connection failures", async () => {
  const scenario = await makeScenario("entry-validation");
  const loaded = loadRuntimeConfig(scenario.configPath);
  const pipes = await brokerPipeNames();
  assert.equal((await probeLifetimePipe(pipes.lifetime)).status, "absent", "never displace an existing broker");
  const instance = randomUUID();
  const pipe = await serveLifetimeDiscovery(pipes.lifetime, { port: scenario.port, configDigest: loaded.configDigest, brokerInstanceId: instance, internalProtocol: 1 });
  const wss = new WebSocketServer({ host: "127.0.0.1", port: scenario.port });
  const violations = ["sessionId", "brokerInstanceId", "welcome", "role"];
  let mode = "sessionId";
  let connections = 0;
  const rejected: number[] = [];
  wss.on("connection", ws => {
    connections++;
    const attemptMode = mode;
    if (attemptMode === "retry" && connections <= 3) { ws.close(1013, "temporary failure"); return; }
    const identity = { brokerInstanceId: instance, sessionId: randomUUID() };
    const welcome = { v: 1, id: randomUUID(), ...identity, type: "welcome", payload: { ...identity, capacity: { maxQueued: 100, maxRunningOrUnknown: 1, maxPendingApprovalsPerEntry: 5, frameMaxBytes: 1048576 } } };
    ws.on("message", data => {
      const message = parseMessage(JSON.parse(String(data)));
      if (message.type === "hello") { ws.send(JSON.stringify(welcome)); return; }
      if (message.type !== "control.request") return;
      let response: unknown = { v: 1, id: randomUUID(), ...identity, type: "control.result", payload: { requestId: message.payload.requestId, result: { recovered: true } } };
      if (attemptMode === "sessionId" || attemptMode === "brokerInstanceId") response = { ...response as object, [attemptMode]: randomUUID() };
      if (attemptMode === "welcome") response = welcome;
      if (attemptMode === "role") response = { v: 1, id: randomUUID(), ...identity, type: "control.request", payload: message.payload };
      parseMessage(response);
      ws.send(JSON.stringify(response));
    });
    ws.on("close", code => { rejected.push(code); });
  });
  try {
    for (const violation of violations) {
      mode = violation;
      const entry = spawnEntry(scenario);
      try {
        await entry.mcp.initialize();
        const result = await entry.mcp.callStatus();
        assert.equal(result.isError, true, violation);
        await waitUntil(() => rejected.includes(4007), 3000, "entry closes invalid broker frame");
        rejected.length = 0;
      } finally { killTree(entry.child); await waitUntil(() => entry.child.exitCode !== null || entry.child.signalCode !== null, 3000, "entry stopped"); }
    }
    mode = "retry"; connections = 0;
    const entry = spawnEntry(scenario);
    try {
      await entry.mcp.initialize();
      const result = await entry.mcp.callStatus();
      assert.equal(result.isError, false);
      assert.equal(result.structuredContent.recovered, true);
      assert.equal(connections, 4, "failed attempts recover without duplicate successful connections");
    } finally { killTree(entry.child); await waitUntil(() => entry.child.exitCode !== null || entry.child.signalCode !== null, 3000, "entry stopped"); }
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => pipe.close(() => resolve()));
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("startup recovery write failure stays observable and dispatch-blocked over WebSocket", async t => {
  const scenario = await makeScenario("write-error-status");
  const loaded = loadRuntimeConfig(scenario.configPath);
  // Inject only the storage writer failure; actual broker, HTTP/WS, schemas,
  // startup and status handling remain real. Disk failure behavior is also
  // exercised independently in recovery-store.test.ts.
  t.mock.method(RecoveryStore.prototype, "save", () => { throw new RecoveryWriteError("injected storage write failure"); });
  const broker = new Broker(loaded);
  let ws: WebSocket | undefined;
  try {
    await broker.start();
    ws = new WebSocket(`ws://127.0.0.1:${scenario.port}/internal/v1/entry`, { headers: { Authorization: `Bearer ${scenario.entryToken}` } });
    const active = ws;
    const status = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("status timeout")), 5000);
      active.on("error", reject);
      active.on("open", () => active.send(JSON.stringify({ v: 1, id: randomUUID(), type: "hello", payload: { role: "entry", internalProtocol: 1, buildId: "fiveai-mcp/0.1.0", configDigest: loaded.configDigest } })));
      active.on("message", data => {
        const message = parseMessage(JSON.parse(String(data)));
        if (message.type === "welcome") active.send(JSON.stringify({ v: 1, id: randomUUID(), brokerInstanceId: message.payload.brokerInstanceId, sessionId: message.payload.sessionId, type: "control.request", payload: { requestId: randomUUID(), tool: "status", arguments: {} } }));
        if (message.type === "control.result") { clearTimeout(timer); resolve(message.payload.result as Record<string, unknown>); }
      });
    });
    assert.equal(status.dispatchBlocked, true);
    assert.equal((status.queue as Record<string, unknown>).state, "blocked");
    assert.equal((status.recovery as Record<string, unknown>).status, "write-error");
    assert.equal((status.recovery as Record<string, unknown>).code, "STATE_STORE_ERROR");
    assert.equal(existsSync(join(scenario.stateDir, "recovery.json")), false);
  } finally {
    ws?.terminate(); await broker.shutdown("write failure test cleanup");
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});

test("a new entry waits through the stopping window and starts only after the old lifetime ends", async () => {
  const scenario = await makeScenario("stopping-entry");
  const broker = new Broker(loadRuntimeConfig(scenario.configPath));
  const pipes = await brokerPipeNames();
  let blocker: net.Socket | undefined;
  let entry: ReturnType<typeof spawnEntry> | undefined;
  try {
    await broker.start();
    // An incomplete HTTP request creates a real open connection while
    // server.close waits, exposing the stop window without production hooks.
    blocker = net.connect(scenario.port, "127.0.0.1");
    const socket = blocker;
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.once("connect", () => socket.write("GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n", () => resolve()));
    });
    await new Promise(resolve => setTimeout(resolve, 50));
    let stopped = false;
    const stopping = broker.shutdown("test slow HTTP shutdown").then(() => { stopped = true; });
    entry = spawnEntry(scenario);
    let stderr = "";
    entry.child.stderr!.setEncoding("utf8");
    entry.child.stderr!.on("data", chunk => { stderr += chunk; });
    await entry.mcp.initialize();
    await waitUntil(() => /initial broker connection failed/.test(stderr), 5000, "new entry encounters stopping broker");
    assert.equal(stopped, false);
    const during = await probeLifetimePipe(pipes.lifetime);
    assert.equal(during.status, "info");
    if (during.status === "info") assert.equal(during.info.brokerInstanceId, broker.brokerInstanceId);
    assert.equal(readRuntime(scenario)?.pid, process.pid, "no successor while old lifetime is held");
    socket.destroy();
    await stopping;
    const status = await awaitStatusOk(entry.mcp);
    assert.notEqual(status.brokerInstanceId, broker.brokerInstanceId);
    assert.notEqual(status.pid, process.pid);
  } finally {
    blocker?.destroy();
    if (entry) killTree(entry.child);
    await broker.shutdown("cleanup");
    // The in-process broker's runtime PID is this test runner: never kill it.
    if (readRuntime(scenario)?.pid !== process.pid) await killBroker(scenario);
    rmSync(scenario.dir, { recursive: true, force: true });
  }
});
