import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";
import { randomBytes, randomUUID } from "node:crypto";
import type { WebSocket as WsSocket, WebSocketServer as WssType } from "ws";
import type { IncomingMessage } from "node:http";
import { WebSocketServer } from "ws";
import { parseMessage, type AnyTypedMessage } from "../src/protocol/envelope.ts";
import { ClientsSnapshotSchema } from "../src/protocol/messages.ts";
import { BoundedExecutionValueSchema } from "../src/protocol/wire-value.ts";
import { BUILD_ID } from "../src/build.ts";

const resource = fileURLToPath(new URL("../../fivem-plugin/artifact/fivem-plugin/", import.meta.url));

test("FiveM resource ships independent executable bundles and client executes only the current server binding", async () => {
  for (const file of ["fxmanifest.lua", "README.md", "dist/server.js", "dist/client.js", "shared/executor.lua"]) {
    assert.equal(existsSync(resource + file), true, `${file} must ship`);
  }
  const events = new Map<string, (...args: unknown[]) => void>();
  const outgoing: unknown[][] = [];
  const ticks: Array<() => void> = [];
  const context = vm.createContext({
    console: { log() {}, error() {} }, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {}, setTick: (fn: () => void) => ticks.push(fn),
    onNet: (name: string, fn: (...args: unknown[]) => void) => events.set(name, fn),
    on: (name: string, fn: (...args: unknown[]) => void) => events.set(name, fn),
    emitNet: (...args: unknown[]) => outgoing.push(args), emit() {},
    GetCurrentResourceName: () => "fivem-plugin", GetPlayerServerId: () => 12, PlayerId: () => 0,
    source: 0,
  });
  // There is deliberately no require, process, Buffer, browser API, or import loader.
  vm.runInContext(readFileSync(resource + "dist/client.js", "utf8"), context);
  assert.ok(outgoing.some(args => args[0] === "fivem-plugin:server:register"));
  const bind = events.get("fivem-plugin:client:bind");
  assert.ok(bind);
  const registration = outgoing.find(args => args[0] === "fivem-plugin:server:register")!;
  const binding = { serverId: 12, clientEpoch: "epoch-12345678", challenge: "challenge-12345678", logMarker: "marker-12345678", nonce: registration[1] };
  bind(binding);
  assert.equal(outgoing.some(args => args[0] === "fivem-plugin:server:ready"), false, "local spoof cannot bind");
  context.source = 65535;
  bind(binding);
  assert.equal(outgoing.some(args => args[0] === "fivem-plugin:server:ready"), true);
  const dispatch = events.get("fivem-plugin:client:execute")!;
  const task = { id: "task-12345678", language: "javascript", code: "async () => { globalThis.executions = (globalThis.executions || 0) + 1; await Promise.resolve(); return undefined; }", args: {} };
  dispatch(binding.clientEpoch, "wrong-challenge", task);
  context.source = 0;
  dispatch(binding.clientEpoch, binding.challenge, task);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.executions, undefined);
  context.source = 65535;
  dispatch(binding.clientEpoch, binding.challenge, task);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(context.executions, 1);
  const result = outgoing.find(args => args[0] === "fivem-plugin:server:result")!;
  assert.equal(result[3], task.id);
  assert.deepEqual(JSON.parse(String(result[4])).result, { language: "javascript", value: { kind: "undefined" } });
  dispatch(binding.clientEpoch, binding.challenge, task);
  assert.equal(context.executions, 1, "duplicate dispatch reuses the result");
  events.get("fivem-plugin:client:ack")!(binding.clientEpoch, binding.challenge, task.id);
  dispatch(binding.clientEpoch, binding.challenge, task);
  assert.equal(context.executions, 1, "acknowledged invocation is not replayed");
});

test("JS executor preserves undefined, BigInt, holes and detects serialization failures after execution", async () => {
  // Runtime source is intentionally dependency-free JavaScript shared by both hosts.
  // @ts-expect-error checked through execution and the receiving protocol schema
  const { executeJavaScript } = await import("../../fivem-plugin/shared/execution.js");
  const success = await executeJavaScript("async (args) => { await new Promise(resolve => setTimeout(resolve, 50)); return [undefined, 42n, , args.value]; }", { value: null });
  assert.equal(success.state, "succeeded");
  BoundedExecutionValueSchema.parse(success.result);
  assert.deepEqual(success.result.value.value, [{ kind: "undefined" }, { kind: "bigint", value: "42" }, { kind: "hole" }, { kind: "null" }]);
  for (const [code, expected] of [
    ["async () => { const x={}; x.x=x; return x; }", "RESULT_UNSERIALIZABLE"],
    ["async () => 'x'.repeat(300000)", "RESULT_TOO_LARGE"],
    ["async () => { throw new Error('sample failure'); }", "EXECUTION_ERROR"],
  ]) {
    const failure = await executeJavaScript(code, {});
    assert.equal(failure.error.code, expected);
    assert.deepEqual(failure.evidence, { executionCompleted: true, noRemoteExecution: false });
  }
});

/**
 * Server-bundle startup harness (unified-artifact RFC section 6). The VM
 * context mimics FXServer: the unified resource must read mcp/config.json
 * via GetResourcePath (never the retired fiveai_mcp_* convars), timers are
 * recorded so backoff delays fire deterministically between pumps, and the
 * process object reports a non-Windows platform so the optional identity
 * lookup stays out of the way (covered by process-identity.test.ts).
 */
interface ServerHarness {
  /** Fire all recorded timers (compressed backoff), then pump host ticks. */
  advance: (rounds?: number) => Promise<void>;
  /** Pump host ticks without firing timers. */
  pump: (rounds?: number) => Promise<void>;
  /** Fire recorded timers without pumping ticks (leaves callbacks pending). */
  fireTimers: () => void;
  setSource: (sender: number) => void;
  lstatCalls: () => number;
  readFileCalls: () => number;
  scheduledTimers: () => number;
  reports: string[];
  frames: AnyTypedMessage[];
  network: Map<string, (...args: unknown[]) => void>;
  commands: Map<string, (sender: number, args: string[]) => void>;
  outgoing: unknown[][];
  stop: () => void;
}

function runServerBundle(options: { resourceName: string; resourceDir: string }): ServerHarness {
  const realRequire = createRequire(import.meta.url);
  let lstatCalls = 0;
  let readFileCalls = 0;
  const harnessRequire = (name: string) => {
    const mod = realRequire(name);
    if (name === "node:fs/promises") {
      return {
        ...mod,
        readFile: (...args: Parameters<typeof mod.readFile>) => {
          readFileCalls += 1;
          return mod.readFile(...args);
        },
        lstat: (...args: Parameters<typeof mod.lstat>) => {
          lstatCalls += 1;
          return mod.lstat(...args);
        },
      };
    }
    return mod;
  };

  const timers = new Map<number, () => void>();
  let timerSeq = 0;
  const ticks: Array<() => void> = [];
  const network = new Map<string, (...args: unknown[]) => void>();
  const local = new Map<string, (...args: unknown[]) => void>();
  const commands = new Map<string, (sender: number, args: string[]) => void>();
  const frames: AnyTypedMessage[] = [];
  const outgoing: unknown[][] = [];
  const reports: string[] = [];
  // A proxy keeps every real process member available to the bundle while
  // reporting a non-Windows platform (the identity lookup path is covered
  // separately; 'platform' itself is read-only on the real process object).
  const fakeProcess = new Proxy(process, {
    get(target, prop, receiver) {
      if (prop === "platform") return "linux";
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    has(target, prop) {
      return prop === "platform" ? true : Reflect.has(target, prop);
    },
  });

  const context = vm.createContext({
    require: harnessRequire, module: { exports: {} }, exports: {}, Buffer, process: fakeProcess,
    console: { log: (value: string) => reports.push(value), error() {} },
    setTimeout: (fn: () => void) => { timers.set(++timerSeq, fn); return timerSeq; },
    clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: () => 1, clearInterval() {}, setTick: (fn: () => void) => ticks.push(fn),
    GetCurrentResourceName: () => options.resourceName,
    GetResourcePath: (name: string) => {
      assert.equal(name, options.resourceName, "the resource path follows the current resource name");
      return options.resourceDir;
    },
    // The unified resource must never read the retired fiveai_mcp_* convars.
    GetConvar: (name: string) => { throw new Error(`unexpected convar read: ${name}`); },
    GetPlayerName: (id: string) => id === "12" ? "fixture-player" : null,
    onNet: (name: string, fn: (...args: unknown[]) => void) => network.set(name, fn),
    on: (name: string, fn: (...args: unknown[]) => void) => local.set(name, fn),
    RegisterCommand: (name: string, fn: (sender: number, args: string[]) => void) => commands.set(name, fn),
    emit() {}, emitNet: (...args: unknown[]) => outgoing.push(args), source: 12,
  });
  vm.runInContext(readFileSync(resource + "dist/server.js", "utf8"), context);

  const fireTimers = () => {
    const pending = [...timers.values()];
    timers.clear();
    for (const fn of pending) fn();
  };
  const pump = async (rounds = 3) => {
    for (let i = 0; i < rounds; i++) {
      for (const tick of ticks) tick();
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  return {
    pump,
    fireTimers,
    advance: async (rounds = 3) => {
      fireTimers();
      await pump(rounds);
    },
    setSource: (sender: number) => { context.source = sender; },
    lstatCalls: () => lstatCalls,
    readFileCalls: () => readFileCalls,
    scheduledTimers: () => timers.size,
    reports, frames, network, commands, outgoing,
    stop: () => local.get("onResourceStop")?.(options.resourceName),
  };
}

/** A fake broker the bridged bundle can connect to; answers welcome + ping. */
async function startBridgeListener(): Promise<{
  port: number;
  token: string;
  frames: AnyTypedMessage[];
  wss: WssType;
  close: () => Promise<void>;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => wss.once("listening", resolve));
  const address = wss.address() as { port: number };
  const token = randomBytes(32).toString("base64");
  const frames: AnyTypedMessage[] = [];
  wss.on("connection", (ws: WsSocket, request: IncomingMessage) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const identity = { brokerInstanceId: randomUUID(), sessionId: randomUUID() };
    ws.on("message", data => {
      const message = parseMessage(JSON.parse(String(data)));
      frames.push(message);
      if (message.type === "hello") {
        ws.send(JSON.stringify({ v: 1, id: randomUUID(), ...identity, type: "welcome", payload: { ...identity, capacity: { maxQueued: 100, maxRunningOrUnknown: 1, maxPendingApprovalsPerEntry: 5, frameMaxBytes: 1048576 } } }));
      }
    });
  });
  return {
    port: address.port,
    token,
    frames,
    wss,
    close: async () => {
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>(resolve => wss.close(() => resolve()));
    },
  };
}

function makeResourceDir(): string {
  return mkdtempSync(join(tmpdir(), "fiveai-resource-"));
}

function writeResourceConfig(dir: string, port: number, verifyEnabled: boolean): void {
  mkdirSync(join(dir, "mcp"), { recursive: true });
  writeFileSync(join(dir, "mcp", "config.json"), JSON.stringify({
    version: 1,
    broker: { host: "127.0.0.1", port },
    serverLabel: "resource-test",
    verifyEnabled,
  }));
}

function writeResourceCredentials(dir: string, token: string): void {
  writeFileSync(join(dir, "mcp", "credentials.json"), JSON.stringify({
    entryToken: randomBytes(32).toString("base64"),
    bridgeToken: token,
  }));
}

test("server bundle bridges from mcp/config.json and credentials under a dynamic resource name", async () => {
  const dir = makeResourceDir();
  const broker = await startBridgeListener();
  let harness: ServerHarness | null = null;
  try {
    harness = runServerBundle({ resourceName: "renamed-res", resourceDir: dir });
    writeResourceConfig(dir, broker.port, true);
    writeResourceCredentials(dir, broker.token);
    for (let i = 0; i < 40 && !broker.frames.some(f => f.type === "clients.snapshot"); i++) {
      await harness.advance(1);
    }
    assert.ok(broker.frames.some(f => f.type === "hello"), "bridge says hello from the file-based config");
    // The hello carries the embedded build identity (F3): the resource
    // bundle shares one identity with the entry/broker of the same build.
    const hello = broker.frames.find(f => f.type === "hello")!;
    assert.equal((hello.payload as { buildId: string }).buildId, BUILD_ID);
    assert.ok(broker.frames.some(f => f.type === "clients.snapshot"), "bridge sends a snapshot");
    assert.deepEqual(
      [...harness.network.keys()].sort(),
      ["renamed-res:server:ready", "renamed-res:server:register", "renamed-res:server:result"],
    );

    // Registration and challenge binding behave exactly as before.
    harness.network.get("renamed-res:server:register")!("registration-nonce");
    const binding = harness.outgoing.at(-1)![2] as { clientEpoch: string; challenge: string; serverId: number };
    assert.equal(binding.serverId, 12);
    harness.network.get("renamed-res:server:ready")!(binding.clientEpoch, "wrong-challenge");
    await harness.pump();
    assert.equal(broker.frames.filter(f => f.type === "clients.snapshot").length, 1);
    harness.network.get("renamed-res:server:ready")!(binding.clientEpoch, binding.challenge);
    await harness.pump();
    const snapshot = broker.frames.filter(f => f.type === "clients.snapshot").at(-1)!;
    const clients = ClientsSnapshotSchema.parse(snapshot.payload).clients;
    assert.equal(clients[0]?.serverId, 12);
    assert.equal(clients[0]?.clientEpoch, binding.clientEpoch);

    // verifyEnabled comes from the config: the console probe runs for the
    // console (sender 0) only, and a bound client answers the dispatch.
    harness.commands.get("fiveai_mcp_verify")!(12, ["12"]);
    await harness.pump();
    assert.equal(harness.outgoing.some(a => a[0] === "renamed-res:client:execute"), false, "player cannot run console probes");
    harness.commands.get("fiveai_mcp_verify")!(0, ["12"]);
    await harness.pump();
    const dispatch = harness.outgoing.find(a => a[0] === "renamed-res:client:execute")!;
    assert.ok(dispatch);
    const task = dispatch[4] as { id: string };
    const received = harness.network.get("renamed-res:server:result")!;
    const valid = JSON.stringify({ state: "succeeded", result: { language: "lua", returns: [{ kind: "string", value: "fiveai" }, { kind: "nil" }, { kind: "number", value: 7 }, { kind: "nil" }] } });
    for (const [sender, epoch, challenge, id, text] of [
      [13, binding.clientEpoch, binding.challenge, task.id, valid],
      [12, "old-epoch", binding.challenge, task.id, valid],
      [12, binding.clientEpoch, "wrong-challenge", task.id, valid],
      [12, binding.clientEpoch, binding.challenge, "wrong-task", valid],
      [12, binding.clientEpoch, binding.challenge, task.id, '{"state":"succeeded","result":true}'],
      [12, binding.clientEpoch, binding.challenge, task.id, '{"state":"failed","error":{"code":"EXECUTION_ERROR","message":"x"},"evidence":{"executionCompleted":false,"noRemoteExecution":false}}'],
    ] as const) {
      harness.setSource(sender);
      received(epoch, challenge, id, text);
    }
    harness.setSource(12);
    await harness.pump();
    assert.equal(harness.outgoing.some(a => a[0] === "renamed-res:client:ack"), false);
    assert.equal(harness.reports.some(line => line.startsWith("FIVEAI_MCP_VERIFY")), false);
    received(binding.clientEpoch, binding.challenge, task.id, valid);
    await harness.pump();
    assert.equal(harness.outgoing.some(a => a[0] === "renamed-res:client:ack"), true);
    assert.ok(harness.reports.some(line => line.startsWith("FIVEAI_MCP_VERIFY")));
  } finally {
    harness?.stop();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing credentials keep waiting with a throttled notice, then auto-connect when the file appears", async () => {
  const dir = makeResourceDir();
  const broker = await startBridgeListener();
  let harness: ServerHarness | null = null;
  try {
    harness = runServerBundle({ resourceName: "fiveai-mcp", resourceDir: dir });
    // verifyEnabled deliberately false: the probe must stay gated off.
    writeResourceConfig(dir, broker.port, false);
    for (let i = 0; i < 8; i++) {
      await harness.advance(1);
    }
    assert.ok(harness.lstatCalls() >= 3, `polled for missing credentials (${harness.lstatCalls()} times)`);
    assert.equal(broker.frames.length, 0, "no connection before credentials exist");
    const notices = harness.reports.filter(line => line.includes("credentials not present yet"));
    assert.equal(notices.length, 1, "the waiting diagnostic repeats at most every 30 seconds");

    // The desktop entry publishes the credentials; the resource connects on
    // its own via the polling backoff (compressed by fireTimers).
    writeResourceCredentials(dir, broker.token);
    for (let i = 0; i < 40 && !broker.frames.some(f => f.type === "hello"); i++) {
      await harness.advance(1);
    }
    assert.ok(broker.frames.some(f => f.type === "hello"), "auto-connects once credentials appear");

    // verifyEnabled=false in the config keeps the console probe off.
    harness.commands.get("fiveai_mcp_verify")!(0, ["server"]);
    await harness.pump(5);
    assert.equal(harness.reports.some(line => line.startsWith("FIVEAI_MCP_VERIFY")), false);
    assert.equal(harness.outgoing.some(a => a[0] === "fiveai-mcp:client:execute"), false);
  } finally {
    harness?.stop();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt credentials are a terminal invalid state for this resource start", async () => {
  const dir = makeResourceDir();
  const broker = await startBridgeListener();
  let harness: ServerHarness | null = null;
  try {
    harness = runServerBundle({ resourceName: "fiveai-mcp", resourceDir: dir });
    writeResourceConfig(dir, broker.port, true);
    mkdirSync(join(dir, "mcp"), { recursive: true });
    writeFileSync(join(dir, "mcp", "credentials.json"), "{ corrupt");
    for (let i = 0; i < 4; i++) {
      await harness.advance(1);
    }
    assert.ok(harness.reports.some(line => line.includes("mcp credentials invalid")), "reports the invalid kind");
    assert.equal(broker.frames.length, 0, "no connection from invalid credentials");
    assert.equal(harness.scheduledTimers(), 0, "no further polling is scheduled");
    const polls = harness.lstatCalls();
    await harness.advance(4);
    assert.equal(harness.lstatCalls(), polls, "terminal: no busy loop after invalid credentials");

    // Fixing the file does not hot-recover: a resource restart is required.
    writeResourceCredentials(dir, broker.token);
    await harness.advance(4);
    assert.equal(broker.frames.length, 0, "no background hot-reload of credentials");
  } finally {
    harness?.stop();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing config is an incomplete installation, reported without credential polling", async () => {
  const dir = makeResourceDir();
  const broker = await startBridgeListener();
  let harness: ServerHarness | null = null;
  try {
    harness = runServerBundle({ resourceName: "fiveai-mcp", resourceDir: dir });
    for (let i = 0; i < 3; i++) {
      await harness.advance(1);
    }
    assert.ok(harness.reports.some(line => line.includes("mcp config unavailable")), "reports the unavailable kind");
    assert.equal(harness.lstatCalls(), 0, "credentials are never polled without a config");
    assert.equal(harness.readFileCalls(), 1, "exactly one config read attempt");
    assert.equal(harness.scheduledTimers(), 0);
    assert.equal(broker.frames.length, 0);
  } finally {
    harness?.stop();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resource stop clears timers and discards late credential read results", async () => {
  const dir = makeResourceDir();
  const broker = await startBridgeListener();
  let harness: ServerHarness | null = null;
  try {
    harness = runServerBundle({ resourceName: "fiveai-mcp", resourceDir: dir });
    writeResourceConfig(dir, broker.port, true);
    for (let i = 0; i < 4; i++) {
      await harness.advance(1);
    }
    assert.ok(harness.reports.some(line => line.includes("credentials not present yet")));
    assert.equal(harness.scheduledTimers(), 1, "a backoff poll is scheduled");

    // Fire the pending poll and stop the resource synchronously: the async
    // read is now in flight and its result must be discarded, never run
    // against natives, and never rescheduled.
    harness.fireTimers();
    harness.stop();
    assert.equal(harness.scheduledTimers(), 0, "stop clears the credential timer");

    const polls = harness.lstatCalls();
    writeResourceCredentials(dir, broker.token);
    await harness.advance(5);
    assert.equal(harness.lstatCalls(), polls, "no polling after the resource stopped");
    assert.equal(broker.frames.length, 0, "late results never establish a connection");
    assert.equal(harness.reports.filter(line => line.includes("credentials not present yet")).length, 1);
  } finally {
    harness?.stop();
    await broker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
