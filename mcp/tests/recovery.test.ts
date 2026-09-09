import assert from "node:assert/strict";
import test from "node:test";
import {
  DispatchIntentRecordSchema,
  RecoveryFileSchema,
  SettledRecordSchema,
} from "../src/protocol/recovery.ts";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const UUID2 = "223e4567-e89b-42d3-a456-426614174001";

const INTENT = {
  kind: "dispatch_intent",
  taskId: UUID,
  brokerInstanceId: UUID2,
  target: { side: "server" },
  toolCategory: "execution",
  createdAt: "2026-09-09T04:35:50.123Z",
};

test("a dispatch intent record parses with its full target binding", () => {
  assert.deepEqual(DispatchIntentRecordSchema.parse(INTENT), INTENT);
  assert.equal(
    DispatchIntentRecordSchema.safeParse({
      ...INTENT,
      target: { side: "client", clientId: 7, clientEpoch: "epoch-0123456789" },
      toolCategory: "resource",
    }).success,
    true,
  );
  assert.equal(
    DispatchIntentRecordSchema.safeParse({ ...INTENT, toolCategory: "logs" }).success,
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
