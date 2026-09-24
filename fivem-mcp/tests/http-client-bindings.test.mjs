import assert from "node:assert/strict";
import test from "node:test";

import {
  ClientBindingManager,
  encodeClientExecute,
} from "../http-mcp/src/execution/client-bindings.ts";

const RESOURCE_EPOCH = "00000000-0000-4000-8000-000000000001";
const CLIENT_EPOCH = "00000000-0000-4000-8000-000000000002";
const CONNECTION_ONE = "00000000-0000-4000-8000-000000000003";
const CONNECTION_TWO = "00000000-0000-4000-8000-000000000004";
const HASH = "a".repeat(64);

function hello(clientEpoch = CLIENT_EPOCH) {
  return JSON.stringify({
    v: 1,
    type: "hello",
    payload: { clientEpoch, lua: true, js: true },
  });
}

function heartbeat(binding, overrides = {}) {
  return JSON.stringify({
    v: 1,
    type: "heartbeat",
    binding,
    payload: { lua: true, js: true, ...overrides },
  });
}

function fakeClock() {
  let now = 0;
  return {
    monotonic: () => now,
    wall: () => new Date(Date.UTC(2026, 8, 22, 0, 0, 0, now)).toISOString(),
    advance: (ms) => {
      now += ms;
    },
  };
}

function makeManager() {
  const clock = fakeClock();
  const sent = [];
  const bound = [];
  const lost = [];
  const terminals = [];
  const uuids = [CONNECTION_ONE, CONNECTION_TWO];
  const manager = new ClientBindingManager({
    resourceName: "renamed-resource",
    resourceEpoch: RESOURCE_EPOCH,
    send: (clientId, eventName, raw) => sent.push({ clientId, eventName, message: JSON.parse(raw) }),
    onTerminal: (message) => {
      terminals.push(message);
      return true;
    },
    onBound: (binding, logMarker) => bound.push({ binding, logMarker }),
    onBindingLost: (binding, reason) => lost.push({ binding, reason }),
    clock: clock.monotonic,
    wall: clock.wall,
    uuid: () => uuids.shift(),
    logMarker: () => "b".repeat(32),
  });
  return { manager, clock, sent, bound, lost, terminals };
}

test("hello is idempotent and a full heartbeat makes the epoch binding ready", () => {
  const { manager, sent, bound } = makeManager();

  assert.equal(manager.receive(7, "hello", hello()), true);
  assert.equal(manager.receive(7, "hello", hello()), true);

  assert.equal(bound.length, 1);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].eventName, "renamed-resource:mcp:v1:bind");
  assert.deepEqual(sent[0].message, sent[1].message);
  const binding = sent[0].message.binding;
  assert.equal(binding.connectionId, CONNECTION_ONE);
  assert.equal(manager.resolveTarget(7), null);

  assert.equal(manager.receive(7, "heartbeat", heartbeat(binding)), true);
  assert.deepEqual(manager.resolveTarget(7), { ...binding, side: "client" });
  assert.deepEqual(manager.snapshots(), [
    {
      clientId: 7,
      connectionId: CONNECTION_ONE,
      clientEpoch: CLIENT_EPOCH,
      ready: true,
      lua: true,
      js: true,
      lastHeartbeat: "2026-09-22T00:00:00.000Z",
    },
  ]);
});

test("network frames require the copied source and exact current binding", () => {
  const { manager, sent, terminals } = makeManager();
  manager.receive(7, "hello", hello());
  const binding = sent[0].message.binding;
  manager.receive(7, "heartbeat", heartbeat(binding));
  manager.sendExecute({ ...binding, side: "client" }, `${RESOURCE_EPOCH}:1`, {
    kind: "js",
    code: "return 42",
    args: {},
    timeoutMs: 1000,
    planHash: HASH,
  });
  const terminal = {
    v: 1,
    type: "terminal",
    binding,
    taskId: `${RESOURCE_EPOCH}:1`,
    payload: { execution: "ended", result: { kind: "values", values: [42] } },
  };

  assert.equal(manager.receive(8, "terminal", JSON.stringify(terminal)), false);
  assert.equal(
    manager.receive(
      7,
      "terminal",
      JSON.stringify({ ...terminal, binding: { ...binding, connectionId: CONNECTION_TWO } }),
    ),
    false,
  );
  assert.equal(terminals.length, 0);

  assert.equal(manager.receive(7, "terminal", JSON.stringify(terminal)), true);
  assert.equal(terminals.length, 1);
  assert.equal(sent.at(-1).eventName, "renamed-resource:mcp:v1:terminalAck");
  assert.equal(sent.at(-1).message.taskId, terminal.taskId);
});

test("heartbeat expiry, player drop, and reused server IDs invalidate the old binding", () => {
  const { manager, clock, sent, lost } = makeManager();
  manager.receive(7, "hello", hello());
  const first = sent[0].message.binding;
  manager.receive(7, "heartbeat", heartbeat(first));
  clock.advance(15_001);
  manager.sweep();
  assert.equal(manager.resolveTarget(7), null);
  assert.deepEqual(lost.map((item) => item.reason), ["heartbeat_timeout"]);

  manager.receive(7, "hello", hello("00000000-0000-4000-8000-000000000009"));
  const second = sent.at(-1).message.binding;
  assert.equal(second.connectionId, CONNECTION_TWO);
  manager.drop(7);
  assert.equal(manager.resolveTarget(7), null);
  assert.deepEqual(lost.map((item) => item.reason), ["heartbeat_timeout", "player_dropped"]);
});

test("an arriving frame cannot revive a binding whose heartbeat deadline already elapsed", () => {
  const { manager, clock, sent, lost } = makeManager();
  manager.receive(7, "hello", hello());
  const first = sent[0].message.binding;
  manager.receive(7, "heartbeat", heartbeat(first));
  clock.advance(15_001);
  manager.receive(7, "hello", hello());
  assert.equal(sent.at(-1).message.binding.connectionId, CONNECTION_TWO);
  assert.deepEqual(lost.map((item) => item.reason), ["heartbeat_timeout"]);
});

test("execute preflight is side-effect free and all outbound events use the actual resource name", () => {
  const { manager, sent } = makeManager();
  manager.receive(7, "hello", hello());
  const binding = sent[0].message.binding;
  manager.receive(7, "heartbeat", heartbeat(binding));
  sent.length = 0;
  const taskId = `${RESOURCE_EPOCH}:1`;
  const payload = { kind: "js", code: "return args.value", args: { value: 42 }, timeoutMs: 1000, planHash: HASH };

  const taskBinding = { ...binding, side: "client" };
  const raw = encodeClientExecute(taskBinding, taskId, payload);
  assert.equal(sent.length, 0);
  assert.equal(JSON.parse(raw).payload.planHash, HASH);
  assert.equal(manager.sendExecute(taskBinding, taskId, payload), true);
  assert.equal(manager.probe(taskBinding, taskId), true);
  assert.deepEqual(sent.map((item) => item.eventName), [
    "renamed-resource:mcp:v1:execute",
    "renamed-resource:mcp:v1:probe",
  ]);
  assert.throws(
    () => encodeClientExecute(taskBinding, `${RESOURCE_EPOCH}:2`, { ...payload, code: "x".repeat(393_216) }),
    /INPUT_TOO_LARGE/,
  );
});

test("a new hello epoch replaces the binding without accepting late terminal evidence", () => {
  const { manager, sent, lost, terminals } = makeManager();
  manager.receive(7, "hello", hello());
  const oldBinding = sent[0].message.binding;
  manager.receive(7, "hello", hello("00000000-0000-4000-8000-000000000009"));
  assert.equal(lost[0].reason, "epoch_replaced");

  const terminal = {
    v: 1,
    type: "terminal",
    binding: oldBinding,
    taskId: `${RESOURCE_EPOCH}:1`,
    payload: { execution: "ended", result: { kind: "values", values: ["late"] } },
  };
  assert.equal(manager.receive(7, "terminal", JSON.stringify(terminal)), false);
  assert.equal(terminals.length, 0);
});
