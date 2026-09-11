import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createRequire } from "node:module";
import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { parseMessage } from "../src/protocol/envelope.ts";
import { ClientsSnapshotSchema } from "../src/protocol/messages.ts";
import { BoundedExecutionValueSchema } from "../src/protocol/wire-value.ts";

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
  const success = await executeJavaScript("async (args) => { await Promise.resolve(); return [undefined, 42n, , args.value]; }", { value: null });
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

test("real server bundle handshakes over WS, binds actual source and never registers a network server executor", async () => {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>(resolve => wss.once("listening", resolve));
  const address = wss.address() as { port: number };
  const token = randomBytes(32).toString("base64");
  const frames: ReturnType<typeof parseMessage>[] = [];
  const network = new Map<string, (...args: unknown[]) => void>();
  const local = new Map<string, (...args: unknown[]) => void>();
  const ticks: Array<() => void> = [];
  const outgoing: unknown[][] = [];
  const commands = new Map<string, (sender: number, args: string[]) => void>();
  const reports: string[] = [];
  let error: unknown;
  wss.on("connection", (ws, request) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    const identity = { brokerInstanceId: randomUUID(), sessionId: randomUUID() };
    ws.on("message", data => {
      try {
        const message = parseMessage(JSON.parse(String(data))); frames.push(message);
        if (message.type === "hello") ws.send(JSON.stringify({ v: 1, id: randomUUID(), ...identity, type: "welcome", payload: { ...identity, capacity: { maxQueued: 100, maxRunningOrUnknown: 1, maxPendingApprovalsPerEntry: 5, frameMaxBytes: 1048576 } } }));
      } catch (failure) { error = failure; }
    });
  });
  const context = vm.createContext({
    require: createRequire(import.meta.url), module: { exports: {} }, exports: {}, Buffer, process, setTimeout, clearTimeout,
    console: { log: (value: string) => reports.push(value), error() {} }, setTick: (fn: () => void) => ticks.push(fn),
    GetCurrentResourceName: () => "fivem-plugin",
    GetConvar: (name: string, fallback: string) => name === "fiveai_mcp_verify_enabled" ? "1" : name === "fiveai_mcp_bridge_token" ? token : name === "fiveai_mcp_broker_url" ? `ws://127.0.0.1:${address.port}/internal/v1/bridge` : fallback,
    GetPlayerName: (id: string) => id === "12" ? "fixture-player" : null,
    onNet: (name: string, fn: (...args: unknown[]) => void) => network.set(name, fn),
    on: (name: string, fn: (...args: unknown[]) => void) => local.set(name, fn),
    RegisterCommand: (name: string, fn: (sender: number, args: string[]) => void) => commands.set(name, fn), emit() {}, emitNet: (...args: unknown[]) => outgoing.push(args), source: 12,
  });
  try {
    vm.runInContext(readFileSync(resource + "dist/server.js", "utf8"), context);
    const pump = async () => {
      for (const tick of ticks) tick();
      await new Promise(resolve => setTimeout(resolve, 10));
      if (error) throw error;
    };
    for (let i = 0; i < 100 && !frames.some(f => f.type === "clients.snapshot"); i++) await pump();
    assert.ok(frames.some(f => f.type === "hello"));
    assert.ok(frames.some(f => f.type === "clients.snapshot"));
    assert.deepEqual([...network.keys()].sort(), ["fivem-plugin:server:ready", "fivem-plugin:server:register", "fivem-plugin:server:result"]);
    network.get("fivem-plugin:server:register")!("registration-nonce");
    const binding = outgoing.at(-1)![2] as { clientEpoch: string; challenge: string; serverId: number };
    assert.equal(binding.serverId, 12);
    network.get("fivem-plugin:server:ready")!(binding.clientEpoch, "wrong-challenge");
    await pump();
    assert.equal(frames.filter(f => f.type === "clients.snapshot").length, 1);
    network.get("fivem-plugin:server:ready")!(binding.clientEpoch, binding.challenge);
    await pump();
    const snapshot = frames.filter(f => f.type === "clients.snapshot").at(-1)!;
    const clients = ClientsSnapshotSchema.parse(snapshot.payload).clients;
    assert.equal(clients[0]?.serverId, 12);
    assert.equal(clients[0]?.clientEpoch, binding.clientEpoch);
    commands.get("fiveai_mcp_verify")!(12, ["12"]);
    await pump();
    assert.equal(outgoing.some(a => a[0] === "fivem-plugin:client:execute"), false, "player cannot run console probes");
    commands.get("fiveai_mcp_verify")!(0, ["12"]);
    await pump();
    const dispatch = outgoing.find(a => a[0] === "fivem-plugin:client:execute")!;
    assert.ok(dispatch);
    const task = dispatch[4] as { id: string };
    const received = network.get("fivem-plugin:server:result")!;
    const valid = JSON.stringify({ state: "succeeded", result: { language: "lua", returns: [{ kind: "string", value: "fiveai" }, { kind: "nil" }, { kind: "number", value: 7 }, { kind: "nil" }] } });
    for (const [sender, epoch, challenge, id, text] of [
      [13, binding.clientEpoch, binding.challenge, task.id, valid],
      [12, "old-epoch", binding.challenge, task.id, valid],
      [12, binding.clientEpoch, "wrong-challenge", task.id, valid],
      [12, binding.clientEpoch, binding.challenge, "wrong-task", valid],
      [12, binding.clientEpoch, binding.challenge, task.id, '{"state":"succeeded","result":true}'],
      [12, binding.clientEpoch, binding.challenge, task.id, '{"state":"failed","error":{"code":"EXECUTION_ERROR","message":"x"},"evidence":{"executionCompleted":false,"noRemoteExecution":false}}'],
    ] as const) {
      context.source = sender; received(epoch, challenge, id, text);
    }
    await pump();
    assert.equal(outgoing.some(a => a[0] === "fivem-plugin:client:ack"), false);
    assert.equal(reports.some(line => line.startsWith("FIVEAI_MCP_VERIFY")), false);
    context.source = 12; received(binding.clientEpoch, binding.challenge, task.id, valid);
    await pump();
    assert.equal(outgoing.some(a => a[0] === "fivem-plugin:client:ack"), true);
    assert.ok(reports.some(line => line.startsWith("FIVEAI_MCP_VERIFY")));
  } finally {
    local.get("onResourceStop")?.("fivem-plugin");
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
  }
});
