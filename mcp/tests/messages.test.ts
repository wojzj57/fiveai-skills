import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalRequestSchema,
  ApprovalResultSchema,
  ClientsSnapshotSchema,
  ControlRequestSchema,
  ControlResultSchema,
  HelloSchema,
  LogsBatchSchema,
  PingSchema,
  PongSchema,
  TargetRefSchema,
  TaskAcceptedSchema,
  TaskDispatchSchema,
  TaskReceivedSchema,
  TaskResultAckSchema,
  TaskResultSchema,
  TaskStatusQuerySchema,
  TaskStatusResultSchema,
  TaskSubmitSchema,
  WelcomeSchema,
} from "../src/protocol/messages.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const EPOCH = "epoch-0123456789";

test("hello distinguishes entry and bridge roles", () => {
  assert.deepEqual(
    HelloSchema.parse({
      role: "entry",
      internalProtocol: 1,
      buildId: "b1",
      configDigest: "d1",
    }),
    { role: "entry", internalProtocol: 1, buildId: "b1", configDigest: "d1" },
  );
  assert.equal(
    HelloSchema.safeParse({
      role: "bridge",
      internalProtocol: 1,
      buildId: "b1",
      adapterDigest: "a1",
      configDigest: "nope",
    }).success,
    false,
  );
  assert.equal(
    HelloSchema.safeParse({
      role: "entry",
      internalProtocol: 2,
      buildId: "b1",
      configDigest: "d1",
    }).success,
    false,
  );
});

test("welcome binds broker identity, session, and capacities", () => {
  assert.equal(
    WelcomeSchema.safeParse({
      brokerInstanceId: UUID,
      sessionId: UUID,
      capacity: {
        maxQueued: 100,
        maxRunningOrUnknown: 1,
        maxPendingApprovalsPerEntry: 5,
        frameMaxBytes: 1048576,
      },
    }).success,
    true,
  );
  assert.equal(
    WelcomeSchema.safeParse({
      brokerInstanceId: UUID,
      sessionId: UUID,
      capacity: { maxQueued: 100 },
    }).success,
    false,
  );
});

test("client targets bind clientId and clientEpoch; server targets carry neither", () => {
  assert.equal(
    TargetRefSchema.safeParse({ side: "server" }).success,
    true,
  );
  assert.equal(
    TargetRefSchema.safeParse({ side: "client", clientId: 3, clientEpoch: EPOCH }).success,
    true,
  );
  assert.equal(
    TargetRefSchema.safeParse({ side: "client" }).success,
    false,
  );
  assert.equal(
    TargetRefSchema.safeParse({ side: "server", clientId: 3 }).success,
    false,
  );
});

test("task results discriminate succeeded/failed terminals", () => {
  const common = {
    taskId: UUID,
    target: { side: "server" },
    queuedMs: 10,
    executionMs: 20,
  };
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "succeeded",
      result: { language: "javascript", value: { kind: "null" } },
    }).success,
    true,
  );
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "succeeded",
    }).success,
    false,
  );
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "failed",
      error: { code: "EXECUTION_ERROR", message: "boom" },
    }).success,
    true,
  );
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "failed",
      result: { language: "javascript", value: { kind: "null" } },
    }).success,
    false,
  );
});

test("late terminal reports may carry the original broker generation", () => {
  const common = {
    taskId: UUID,
    target: { side: "server" },
    queuedMs: 10,
    executionMs: 20,
    originalBrokerInstanceId: "323e4567-e89b-42d3-a456-426614174002",
  };
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "succeeded",
      result: { language: "lua", returns: [{ kind: "nil" }] },
    }).success,
    true,
  );
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "failed",
      error: {
        code: "CONNECTION_LOST_UNKNOWN",
        message: "late failure",
        sideEffectsUnknown: true,
        retrySafe: false,
      },
    }).success,
    true,
  );
});

test("task.submit only accepts FIFO tools; read/control tools ride control.request", () => {
  assert.equal(
    TaskSubmitSchema.safeParse({
      tool: "execute_lua",
      arguments: { side: "server", code: "return 1" },
      requestId: UUID,
    }).success,
    true,
  );
  for (const tool of ["status", "queue", "logs", "reference"]) {
    assert.equal(
      TaskSubmitSchema.safeParse({ tool, arguments: {}, requestId: UUID }).success,
      false,
      `${tool} must not enter task.submit`,
    );
  }
});

test("resource reads are blocked from the FIFO at the wire level (RFC §11)", () => {
  for (const action of ["list", "status"]) {
    assert.equal(
      TaskSubmitSchema.safeParse({
        tool: "resource",
        arguments: { action },
        requestId: UUID,
      }).success,
      false,
      `resource ${action} must not enter task.submit`,
    );
    assert.equal(
      TaskDispatchSchema.safeParse({
        taskId: UUID,
        target: { side: "server" },
        tool: "resource",
        arguments: { action },
        deadlineMs: 30_000,
        timeoutMs: 30_000,
      }).success,
      false,
      `resource ${action} must not be dispatched`,
    );
  }
  assert.equal(
    TaskSubmitSchema.safeParse({
      tool: "resource",
      arguments: { action: "restart", name: "my-resource" },
      requestId: UUID,
    }).success,
    true,
  );
  // The action guard must only apply to the resource tool.
  assert.equal(
    TaskSubmitSchema.safeParse({
      tool: "execute_lua",
      arguments: { side: "server", code: "return args.action", action: "list" },
      requestId: UUID,
    }).success,
    true,
  );
});

test("the task chain payloads carry their required semantics", () => {
  assert.equal(
    TaskAcceptedSchema.safeParse({ taskId: UUID, sequence: 1, state: "queued" }).success,
    true,
  );
  assert.equal(
    TaskAcceptedSchema.safeParse({ taskId: UUID, state: "queued" }).success,
    false,
  );
  assert.equal(
    TaskDispatchSchema.safeParse({
      taskId: UUID,
      target: { side: "client", clientId: 4, clientEpoch: EPOCH },
      tool: "execute_ts",
      arguments: { side: "client", clientId: 4, code: "return args" },
      deadlineMs: 30_000,
      timeoutMs: 30_000,
    }).success,
    true,
  );
  assert.equal(
    TaskDispatchSchema.safeParse({
      taskId: UUID,
      target: { side: "server" },
      tool: "execute_ts",
      arguments: {},
      deadlineMs: 0,
      timeoutMs: 30_000,
    }).success,
    false,
  );
  assert.equal(TaskReceivedSchema.safeParse({ taskId: UUID }).success, true);
  assert.equal(TaskResultAckSchema.safeParse({ taskId: UUID }).success, true);
  assert.equal(TaskStatusQuerySchema.safeParse({ taskId: UUID }).success, true);
  assert.equal(
    TaskStatusQuerySchema.safeParse({ taskId: UUID, code: "secret" }).success,
    false,
  );
  assert.equal(
    TaskStatusResultSchema.safeParse({
      taskId: UUID,
      state: "unknown",
      resultAvailable: false,
    }).success,
    true,
  );
  assert.equal(
    TaskStatusResultSchema.safeParse({
      taskId: UUID,
      state: "succeeded",
      result: { language: "javascript", value: { kind: "null" } },
      resultAvailable: true,
    }).success,
    true,
  );
  assert.equal(
    TaskStatusResultSchema.safeParse({
      taskId: UUID,
      state: "failed",
      error: { code: "EXECUTION_ERROR", message: "boom" },
      resultAvailable: true,
    }).success,
    true,
  );
  assert.equal(
    TaskStatusResultSchema.safeParse({
      taskId: UUID,
      state: "succeeded",
      resultAvailable: true,
    }).success,
    false,
  );
  assert.equal(
    TaskStatusResultSchema.safeParse({
      taskId: UUID,
      state: "succeeded",
      resultAvailable: true,
      result: { language: "javascript", value: { kind: "null" } },
      error: { code: "EXECUTION_ERROR", message: "conflicting" },
    }).success,
    false,
  );
});

test("ping and pong carry a nonce and nothing else", () => {
  assert.equal(PingSchema.safeParse({ nonce: "n1" }).success, true);
  assert.equal(PingSchema.safeParse({ nonce: "" }).success, false);
  assert.equal(PongSchema.safeParse({ nonce: "n1", state: "queued" }).success, false);
});

test("control requests accept only broker-local control tools", () => {
  assert.equal(
    ControlRequestSchema.safeParse({
      requestId: UUID,
      tool: "status",
      arguments: {},
    }).success,
    true,
  );
  for (const tool of ["execute_lua", "execute_ts", "esx", "qbcore", "ox", "resource"]) {
    assert.equal(
      ControlRequestSchema.safeParse({ requestId: UUID, tool, arguments: {} }).success,
      false,
      `${tool} must not ride the control channel`,
    );
  }
  assert.equal(
    ControlResultSchema.safeParse({
      requestId: UUID,
      result: { connected: false },
    }).success,
    true,
  );
  assert.equal(
    ControlResultSchema.safeParse({
      requestId: UUID,
      error: { code: "QUEUE_PAUSED", message: "paused" },
    }).success,
    true,
  );
  assert.equal(
    ControlResultSchema.safeParse({ requestId: UUID }).success,
    false,
  );
});

test("approval accept requires an explicit confirm=true", () => {
  const base = { approvalId: UUID, digest: "d1" };
  assert.equal(
    ApprovalResultSchema.safeParse({ ...base, action: "accept" }).success,
    false,
  );
  assert.equal(
    ApprovalResultSchema.safeParse({ ...base, action: "accept", confirm: false }).success,
    false,
  );
  assert.equal(
    ApprovalResultSchema.safeParse({ ...base, action: "accept", confirm: true }).success,
    true,
  );
  assert.equal(
    ApprovalResultSchema.safeParse({ ...base, action: "decline" }).success,
    true,
  );
  assert.equal(
    ApprovalResultSchema.safeParse({ ...base, action: "cancel" }).success,
    true,
  );
});

test("approval requests carry the full confirmation binding", () => {
  assert.equal(
    ApprovalRequestSchema.safeParse({
      approvalId: UUID,
      digest: "d1",
      method: "update",
      sql: "UPDATE users SET money = money + 1 WHERE id = ?",
      parameters: [1],
      serverEpoch: EPOCH,
      bridgeEpoch: EPOCH,
      entrySessionId: UUID,
      requestId: UUID,
    }).success,
    true,
  );
  assert.equal(
    ApprovalRequestSchema.safeParse({
      approvalId: UUID,
      digest: "d1",
      method: "update",
      sql: "UPDATE users SET money = money + 1",
      parameters: [],
      serverEpoch: EPOCH,
      bridgeEpoch: EPOCH,
      entrySessionId: UUID,
    }).success,
    false,
  );
});

test("logs batches carry structured records and a drop counter", () => {
  const record = {
    logId: "l1",
    source: "server",
    streamId: "s1",
    sequence: 0,
    observedAt: "2026-09-09T04:35:50.123Z",
    message: "hello",
    truncated: false,
  };
  assert.equal(
    LogsBatchSchema.safeParse({
      streamId: "s1",
      sequence: 5,
      records: [
        record,
        { ...record, logId: "l2", source: "client", clientEpoch: EPOCH, resource: "vMenu", channel: "script:vMenu", raw: "\u001b[0mhello", sequence: 1 },
        { ...record, logId: "l3", message: "", sequence: 2 },
        // RFC §12.1: unknown attribution is resource=null (explicit null form).
        { ...record, logId: "l4", resource: null, sourceTime: null, sequence: 3 },
      ],
      droppedCount: 0,
    }).success,
    true,
  );
  assert.equal(
    LogsBatchSchema.safeParse({
      streamId: "s1",
      sequence: 5,
      records: [{ ...record, source: "unknown-side" }],
      droppedCount: 0,
    }).success,
    false,
  );
  assert.equal(
    LogsBatchSchema.safeParse({
      streamId: "s1",
      sequence: 5,
      records: [{ ...record, observedAt: "2026-02-30T00:00:00Z" }],
      droppedCount: 0,
    }).success,
    false,
  );
});

test("clients snapshot maps server IDs to epochs, capabilities, and log markers", () => {
  assert.equal(
    ClientsSnapshotSchema.safeParse({
      bridgeEpoch: EPOCH,
      clients: [
        {
          serverId: 1,
          clientEpoch: EPOCH,
          capabilities: ["lua", "js"],
          logMarker: "m1",
        },
      ],
    }).success,
    true,
  );
  assert.equal(
    ClientsSnapshotSchema.safeParse({
      bridgeEpoch: EPOCH,
      clients: [{ serverId: -1, clientEpoch: EPOCH, capabilities: [], logMarker: "m" }],
    }).success,
    false,
  );
});
