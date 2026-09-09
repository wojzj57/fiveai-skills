import assert from "node:assert/strict";
import test from "node:test";
import {
  ApprovalRequestSchema,
  ApprovalResultSchema,
  BridgeReadRequestSchema,
  BridgeReadResultSchema,
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
import { ResourceInputSchema } from "../src/tools/schemas.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const EPOCH = "epoch-0123456789";
const ENV = {
  bridgeEpoch: "bridge-0123456789",
  serverPid: 4242,
  serverStartedAt: "2026-09-09T04:35:50.123Z",
  serverIdentityVerifiable: true,
};
const EVIDENCE = { executionCompleted: true, noRemoteExecution: false };

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

test("bridge hello carries its execution environment identity (review F2)", () => {
  assert.equal(
    HelloSchema.safeParse({
      role: "bridge",
      internalProtocol: 1,
      buildId: "b1",
      adapterDigest: "a1",
      environment: ENV,
    }).success,
    true,
  );
  // An unverifiable server identity is representable but flagged (RFC §5.2).
  assert.equal(
    HelloSchema.safeParse({
      role: "bridge",
      internalProtocol: 1,
      buildId: "b1",
      adapterDigest: "a1",
      environment: { ...ENV, serverIdentityVerifiable: false },
    }).success,
    true,
  );
  // The identity is required, not implied by the authenticated connection.
  assert.equal(
    HelloSchema.safeParse({
      role: "bridge",
      internalProtocol: 1,
      buildId: "b1",
      adapterDigest: "a1",
    }).success,
    false,
  );
  assert.equal(
    HelloSchema.safeParse({
      role: "bridge",
      internalProtocol: 1,
      buildId: "b1",
      adapterDigest: "a1",
      environment: { ...ENV, serverPid: -1 },
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
    executedBy: ENV,
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
      evidence: EVIDENCE,
    }).success,
    true,
  );
  // Failed reports must carry completion evidence (review F3).
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "failed",
      error: { code: "EXECUTION_ERROR", message: "boom" },
    }).success,
    false,
  );
  assert.equal(
    TaskResultSchema.safeParse({
      ...common,
      state: "failed",
      result: { language: "javascript", value: { kind: "null" } },
      evidence: EVIDENCE,
    }).success,
    false,
  );
});

test("unknown-outcome errors are broker observations, never bridge terminals (review F3)", () => {
  const common = {
    taskId: UUID,
    target: { side: "server" },
    executedBy: ENV,
    queuedMs: 10,
    executionMs: 20,
  };
  for (const code of ["TIMEOUT_UNKNOWN", "CONNECTION_LOST_UNKNOWN"] as const) {
    // With the flags the error schema demands, the terminal ban still rejects.
    assert.equal(
      TaskResultSchema.safeParse({
        ...common,
        state: "failed",
        error: {
          code,
          message: "not known to have ended",
          sideEffectsUnknown: true,
          retrySafe: false,
        },
        evidence: EVIDENCE,
      }).success,
      false,
      `${code} must never be a bridge-reported terminal result`,
    );
    // Without the flags the error schema itself rejects.
    assert.equal(
      TaskResultSchema.safeParse({
        ...common,
        state: "failed",
        error: { code, message: "not known to have ended" },
        evidence: EVIDENCE,
      }).success,
      false,
    );
  }
});

test("failure evidence follows the RFC error stages (review F3)", () => {
  const common = {
    taskId: UUID,
    target: { side: "server" },
    executedBy: ENV,
    queuedMs: 10,
    executionMs: 20,
  };
  const failedWith = (code: string, evidence: unknown) =>
    TaskResultSchema.safeParse({
      ...common,
      state: "failed",
      error: { code, message: "stage" },
      evidence,
    }).success;

  // RFC §8: compiler errors happen before execution.
  assert.equal(
    failedWith("COMPILATION_ERROR", { executionCompleted: false, noRemoteExecution: true }),
    true,
  );
  assert.equal(
    failedWith("COMPILATION_ERROR", { executionCompleted: true, noRemoteExecution: false }),
    false,
  );
  // RFC §6.3: serialization failures mean the function already ended.
  assert.equal(
    failedWith("RESULT_UNSERIALIZABLE", { executionCompleted: true, noRemoteExecution: false }),
    true,
  );
  assert.equal(
    failedWith("RESULT_UNSERIALIZABLE", { executionCompleted: false, noRemoteExecution: true }),
    false,
  );
  assert.equal(
    failedWith("RESULT_TOO_LARGE", { executionCompleted: true, noRemoteExecution: false }),
    true,
  );
  assert.equal(
    failedWith("RESULT_TOO_LARGE", { executionCompleted: false, noRemoteExecution: false }),
    false,
  );
  // Other stages carry their own evidence; the schema does not guess.
  assert.equal(
    failedWith("EXECUTION_ERROR", { executionCompleted: true, noRemoteExecution: false }),
    true,
  );
  assert.equal(
    failedWith("EXECUTION_ERROR", { executionCompleted: false, noRemoteExecution: false }),
    true,
  );
});

test("late terminal reports may carry the original broker generation", () => {
  const common = {
    taskId: UUID,
    target: { side: "server" },
    executedBy: ENV,
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
      error: { code: "EXECUTION_ERROR", message: "late failure" },
      evidence: EVIDENCE,
    }).success,
    true,
  );
  // A late failure is still a verified terminal: unknown-outcome codes stay
  // broker observations even across a broker restart.
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
      evidence: EVIDENCE,
    }).success,
    false,
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
      evidence: EVIDENCE,
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

test("task status payloads are discriminated by state (review F3)", () => {
  const status = (overrides: Record<string, unknown>) =>
    TaskStatusResultSchema.safeParse({ taskId: UUID, ...overrides }).success;
  const executionError = { code: "EXECUTION_ERROR", message: "boom" };
  const unknownError = {
    code: "TIMEOUT_UNKNOWN",
    message: "timed out",
    sideEffectsUnknown: true,
    retrySafe: false,
  };

  // unknown: observation errors only, never a full payload
  assert.equal(status({ state: "unknown", resultAvailable: false }), true);
  assert.equal(
    status({ state: "unknown", resultAvailable: false, error: unknownError }),
    true,
  );
  assert.equal(
    status({ state: "unknown", resultAvailable: false, error: executionError }),
    false,
  );
  assert.equal(
    status({ state: "unknown", resultAvailable: true, error: unknownError }),
    false,
  );
  assert.equal(
    status({
      state: "unknown",
      resultAvailable: false,
      error: unknownError,
      evidence: EVIDENCE,
    }),
    false,
  );

  // succeeded: resultAvailable must equal result presence; no error/evidence
  const result = { language: "javascript", value: { kind: "null" } };
  assert.equal(
    status({ state: "succeeded", resultAvailable: true, result }),
    true,
  );
  assert.equal(
    status({ state: "succeeded", resultAvailable: false }),
    true,
  );
  assert.equal(
    status({ state: "succeeded", resultAvailable: false, result }),
    false,
  );
  // Review repro: a succeeded status must not carry an error at all.
  assert.equal(
    status({ state: "succeeded", resultAvailable: true, result, error: unknownError }),
    false,
  );

  // failed: resultAvailable must equal error presence, evidence alongside
  assert.equal(
    status({ state: "failed", resultAvailable: true, error: executionError, evidence: EVIDENCE }),
    true,
  );
  assert.equal(
    status({ state: "failed", resultAvailable: true, error: executionError }),
    false,
  );
  assert.equal(
    status({ state: "failed", resultAvailable: false }),
    true,
  );
  // A summary without the full payload drops the error too.
  assert.equal(
    status({ state: "failed", resultAvailable: false, error: executionError }),
    false,
  );
  assert.equal(
    status({ state: "failed", resultAvailable: true, error: unknownError, evidence: EVIDENCE }),
    false,
  );

  // queued / running / cancelled never carry terminal payloads
  assert.equal(status({ state: "queued", resultAvailable: false }), true);
  assert.equal(status({ state: "running", resultAvailable: false }), true);
  assert.equal(status({ state: "cancelled", resultAvailable: false }), true);
  assert.equal(
    status({ state: "running", resultAvailable: false, error: executionError }),
    false,
  );
  assert.equal(
    status({ state: "cancelled", resultAvailable: true, result }),
    false,
  );
});

test("ping and pong carry a nonce and nothing else", () => {
  assert.equal(PingSchema.safeParse({ nonce: "n1" }).success, true);
  assert.equal(PingSchema.safeParse({ nonce: "" }).success, false);
  assert.equal(PongSchema.safeParse({ nonce: "n1", state: "queued" }).success, false);
});

test("control channel serves reads and controls; resource is read-only there (RFC §11, review F4)", () => {
  assert.equal(
    ControlRequestSchema.safeParse({
      requestId: UUID,
      tool: "status",
      arguments: {},
    }).success,
    true,
  );
  for (const tool of ["execute_lua", "execute_ts", "esx", "qbcore", "ox"]) {
    assert.equal(
      ControlRequestSchema.safeParse({ requestId: UUID, tool, arguments: {} }).success,
      false,
      `${tool} must not ride the control channel`,
    );
  }
  // Resource reads ride the control channel...
  assert.equal(
    ControlRequestSchema.safeParse({
      requestId: UUID,
      tool: "resource",
      arguments: { action: "list" },
    }).success,
    true,
  );
  assert.equal(
    ControlRequestSchema.safeParse({
      requestId: UUID,
      tool: "resource",
      arguments: { action: "status", name: "my-resource" },
    }).success,
    true,
  );
  // ...but mutations never do.
  for (const action of ["start", "stop", "restart"]) {
    assert.equal(
      ControlRequestSchema.safeParse({
        requestId: UUID,
        tool: "resource",
        arguments: { action, name: "my-resource" },
      }).success,
      false,
      `resource ${action} must enter the FIFO, not the control channel`,
    );
  }
  // Read-shaped but invalid arguments are rejected too.
  assert.equal(
    ControlRequestSchema.safeParse({
      requestId: UUID,
      tool: "resource",
      arguments: { action: "status" },
    }).success,
    false,
  );
  assert.equal(
    ControlRequestSchema.safeParse({
      requestId: UUID,
      tool: "resource",
      arguments: { action: "list", name: "x" },
    }).success,
    false,
  );
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

test("resource reads route public request -> control channel -> bridge read, never the FIFO (review F4)", () => {
  const readArguments = [
    { action: "list" },
    { action: "status", name: "my-resource" },
  ];
  for (const arguments_ of readArguments) {
    assert.equal(ResourceInputSchema.safeParse(arguments_).success, true);
    assert.equal(
      ControlRequestSchema.safeParse({ requestId: UUID, tool: "resource", arguments: arguments_ }).success,
      true,
      "control channel accepts the read",
    );
    assert.equal(
      BridgeReadRequestSchema.safeParse({ requestId: UUID, tool: "resource", arguments: arguments_ }).success,
      true,
      "broker forwards the read to the bridge",
    );
    assert.equal(
      TaskSubmitSchema.safeParse({ tool: "resource", arguments: arguments_, requestId: UUID }).success,
      false,
      "reads never enter the FIFO",
    );
    assert.equal(
      TaskDispatchSchema.safeParse({
        taskId: UUID,
        target: { side: "server" },
        tool: "resource",
        arguments: arguments_,
        deadlineMs: 30_000,
        timeoutMs: 30_000,
      }).success,
      false,
      "reads are never dispatched",
    );
  }
});

test("bridge read requests only accept resource reads; results carry live/cached source", () => {
  assert.equal(
    BridgeReadRequestSchema.safeParse({
      requestId: UUID,
      tool: "resource",
      arguments: { action: "restart", name: "my-resource" },
    }).success,
    false,
  );
  assert.equal(
    BridgeReadRequestSchema.safeParse({
      requestId: UUID,
      tool: "execute_lua",
      arguments: { action: "list" },
    }).success,
    false,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      result: {
        action: "list",
        source: "live",
        resources: [{ name: "my-resource", state: "started" }],
      },
    }).success,
    true,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      result: {
        action: "status",
        source: "cached",
        name: "my-resource",
        state: "stopped",
      },
    }).success,
    true,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      result: {
        action: "status",
        source: "wrong",
        name: "my-resource",
        state: "stopped",
      },
    }).success,
    false,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      result: { action: "restart", name: "my-resource", source: "live" },
    }).success,
    false,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      result: {
        action: "list",
        source: "live",
        resources: [{ name: "bad/name", state: "started" }],
      },
    }).success,
    false,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({ requestId: UUID }).success,
    false,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      result: { action: "list", source: "live", resources: [] },
      error: { code: "TARGET_UNAVAILABLE", message: "no bridge" },
    }).success,
    false,
  );
  assert.equal(
    BridgeReadResultSchema.safeParse({
      requestId: UUID,
      error: { code: "TARGET_UNAVAILABLE", message: "no bridge" },
    }).success,
    true,
  );
});

test("deep message payloads fail as structured validation errors, not RangeError (review F5)", () => {
  let deep: unknown = 0;
  for (let index = 0; index < 2_000; index += 1) deep = [deep];
  const submit = TaskSubmitSchema.safeParse({
    tool: "execute_lua",
    arguments: deep,
    requestId: UUID,
  });
  assert.equal(submit.success, false);
  const control = ControlRequestSchema.safeParse({
    requestId: UUID,
    tool: "status",
    arguments: deep,
  });
  assert.equal(control.success, false);
  const approval = ApprovalRequestSchema.safeParse({
    approvalId: UUID,
    digest: "d1",
    method: "update",
    sql: "UPDATE users SET money = money + 1 WHERE id = ?",
    parameters: deep,
    serverEpoch: EPOCH,
    bridgeEpoch: EPOCH,
    entrySessionId: UUID,
    requestId: UUID,
  });
  assert.equal(approval.success, false);
  const dispatch = TaskDispatchSchema.safeParse({
    taskId: UUID,
    target: { side: "server" },
    tool: "execute_lua",
    arguments: deep,
    deadlineMs: 30_000,
    timeoutMs: 30_000,
  });
  assert.equal(dispatch.success, false);
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
