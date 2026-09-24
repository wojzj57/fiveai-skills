import assert from "node:assert/strict";
import test from "node:test";
import {
  DispatchIntentRecordSchema,
  RecoveryFileSchema,
  SettledRecordSchema,
  matchesDispatchIntent,
  type TaskResultIdentity,
} from "../src/protocol/recovery.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "223e4567-e89b-42d3-a456-426614174001";
const UUID3 = "323e4567-e89b-42d3-a456-426614174002";

const ENV = {
  bridgeEpoch: "bridge-0123456789",
  serverPid: 4242,
  serverStartedAt: "2026-09-09T04:35:50.123Z",
  serverIdentityVerifiable: true,
};

const INTENT = {
  kind: "dispatch_intent",
  taskId: UUID,
  brokerInstanceId: UUID2,
  target: { side: "server" },
  environment: ENV,
  toolCategory: "execution",
  createdAt: "2026-09-09T04:35:50.123Z",
};

test("a dispatch intent record parses with its full target and environment binding", () => {
  assert.deepEqual(DispatchIntentRecordSchema.parse(INTENT), INTENT);
  assert.equal(
    DispatchIntentRecordSchema.safeParse({
      ...INTENT,
      target: { side: "client", clientId: 7, clientEpoch: "epoch-0123456789" },
      toolCategory: "resource",
    }).success,
    true,
  );
  // The execution environment identity is required (review F2): without it
  // a restarted broker cannot verify which server/bridge executed the task.
  assert.equal(
    DispatchIntentRecordSchema.safeParse({
      kind: "dispatch_intent",
      taskId: UUID,
      brokerInstanceId: UUID2,
      target: { side: "server" },
      toolCategory: "execution",
      createdAt: "2026-09-09T04:35:50.123Z",
    }).success,
    false,
  );
  assert.equal(
    DispatchIntentRecordSchema.safeParse({ ...INTENT, toolCategory: "logs" }).success,
    false,
  );
});

test("late reports settle a dispatch intent only on full identity match (review F2)", () => {
  const report = (
    overrides: Partial<TaskResultIdentity> = {},
  ): TaskResultIdentity => ({
    taskId: UUID,
    target: { side: "server" },
    executedBy: ENV,
    ...overrides,
  });
  // Same task, target, and environment: the original executor reported.
  assert.equal(matchesDispatchIntent(DispatchIntentRecordSchema.parse(INTENT), report()), true);
  // Different task id: unrelated report.
  assert.equal(matchesDispatchIntent(DispatchIntentRecordSchema.parse(INTENT), report({ taskId: UUID3 })), false);
  // Bridge restarted (new bridgeEpoch): not the original executor.
  assert.equal(
    matchesDispatchIntent(
      DispatchIntentRecordSchema.parse(INTENT),
      report({ executedBy: { ...ENV, bridgeEpoch: "bridge-9876543210" } }),
    ),
    false,
  );
  // Another server process: different pid.
  assert.equal(
    matchesDispatchIntent(
      DispatchIntentRecordSchema.parse(INTENT),
      report({ executedBy: { ...ENV, serverPid: 9999 } }),
    ),
    false,
  );
  // PID reuse: same pid, different process creation time.
  assert.equal(
    matchesDispatchIntent(
      DispatchIntentRecordSchema.parse(INTENT),
      report({ executedBy: { ...ENV, serverStartedAt: "2026-09-09T09:00:00.000Z" } }),
    ),
    false,
  );
  // Verifiability is part of the recorded identity.
  assert.equal(
    matchesDispatchIntent(
      DispatchIntentRecordSchema.parse(INTENT),
      report({ executedBy: { ...ENV, serverIdentityVerifiable: false } }),
    ),
    false,
  );
  // Server ID reuse: the clientEpoch binding breaks the match.
  const clientIntent = DispatchIntentRecordSchema.parse({
    ...INTENT,
    target: { side: "client", clientId: 7, clientEpoch: "epoch-0123456789" },
  });
  assert.equal(
    matchesDispatchIntent(
      clientIntent,
      report({
        target: { side: "client", clientId: 7, clientEpoch: "epoch-1123456789" },
      }),
    ),
    false,
  );
  assert.equal(
    matchesDispatchIntent(
      clientIntent,
      report({
        target: { side: "client", clientId: 8, clientEpoch: "epoch-0123456789" },
      }),
    ),
    false,
  );
});

test("recovery records never persist code, SQL, or bound parameters", () => {
  for (const forbidden of [
    { code: "return 1" },
    { sql: "UPDATE users SET x = 1" },
    { args: [1, 2] },
    { parameters: [1] },
    { result: { ok: true } },
  ]) {
    assert.equal(
      DispatchIntentRecordSchema.safeParse({ ...INTENT, ...forbidden }).success,
      false,
      `dispatch intent must reject ${Object.keys(forbidden)[0]}`,
    );
    assert.equal(
      SettledRecordSchema.safeParse({
        kind: "settled",
        taskId: UUID,
        brokerInstanceId: UUID2,
        state: "failed",
        settledAt: "2026-09-09T04:35:50.123Z",
        resultDigest: "d1",
        ...forbidden,
      }).success,
      false,
    );
  }
});

test("settled records only keep terminal summaries", () => {
  assert.equal(
    SettledRecordSchema.safeParse({
      kind: "settled",
      taskId: UUID,
      brokerInstanceId: UUID2,
      state: "succeeded",
      settledAt: "2026-09-09T04:35:50.123Z",
      resultDigest: "d1",
    }).success,
    true,
  );
  assert.equal(
    SettledRecordSchema.safeParse({
      kind: "settled",
      taskId: UUID,
      brokerInstanceId: UUID2,
      state: "queued",
      settledAt: "2026-09-09T04:35:50.123Z",
      resultDigest: "d1",
    }).success,
    false,
  );
});

test("the recovery file holds at most one pending intent and a bounded history", () => {
  const settled = (index: number) => ({
    kind: "settled",
    taskId: `123e4567-e89b-42d3-a456-4266141740${String(index).padStart(2, "0")}`,
    brokerInstanceId: UUID2,
    state: "succeeded",
    settledAt: "2026-09-09T04:35:50.123Z",
    resultDigest: `d${index}`,
  });
  const base = {
    version: 1,
    brokerInstanceId: UUID2,
    pending: INTENT,
    history: [],
  };
  assert.equal(RecoveryFileSchema.safeParse(base).success, true);
  assert.equal(
    RecoveryFileSchema.safeParse({ ...base, pending: null, history: [] }).success,
    true,
  );
  assert.equal(
    RecoveryFileSchema.safeParse({
      ...base,
      pending: null,
      history: Array.from({ length: 100 }, (_, index) => settled(index)),
    }).success,
    true,
  );
  assert.equal(
    RecoveryFileSchema.safeParse({
      ...base,
      pending: null,
      history: Array.from({ length: 101 }, (_, index) => settled(index)),
    }).success,
    false,
  );
});
