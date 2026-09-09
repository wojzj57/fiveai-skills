import assert from "node:assert/strict";
import test from "node:test";
import { LIMITS } from "../src/protocol/limits.ts";

/**
 * Drift guard: every limit must stay at its RFC-fixed value (§4.3, §5.1,
 * §6.2, §7.2). Any change here requires an RFC revision, not a code edit.
 */
test("engineering limits stay at the RFC-fixed values", () => {
  assert.deepEqual(LIMITS.heartbeat, { intervalMs: 5_000, lossAfterMs: 15_000 });
  assert.equal(LIMITS.gracePeriodMs, 30_000);
  assert.deepEqual(LIMITS.bridgeReconnect, {
    backoffScheduleMs: [1_000, 2_000, 4_000, 8_000],
    backoffCapMs: 10_000,
  });
  assert.deepEqual(LIMITS.message, {
    frameMaxBytes: 1024 * 1024,
    logsBatchMaxRecords: 100,
    logsBatchFlushMs: 100,
  });
  assert.deepEqual(LIMITS.execution, {
    timeoutMsDefault: 30_000,
    timeoutMsMin: 100,
    timeoutMsMax: 300_000,
  });
  assert.equal(LIMITS.toolSyncWaitMs, 20_000);
  assert.deepEqual(LIMITS.approval, {
    waitMs: 300_000,
    maxPendingPerEntry: 5,
    displayMaxBytes: 32 * 1024,
  });
  assert.deepEqual(LIMITS.queue, { maxQueued: 100, maxRunningOrUnknown: 1 });
  assert.deepEqual(LIMITS.payload, {
    codeMaxBytes: 64 * 1024,
    argsMaxBytes: 128 * 1024,
  });
  assert.deepEqual(LIMITS.result, {
    maxBytes: 256 * 1024,
    maxEncodeDepth: 32,
    maxElementCount: 10_000,
  });
  assert.deepEqual(LIMITS.taskCache, {
    maxEntries: 1_000,
    maxAgeMs: 30 * 60_000,
    maxTotalResultBytes: 32 * 1024 * 1024,
  });
  assert.deepEqual(LIMITS.logs, {
    perStreamMaxEntries: 50_000,
    perStreamMaxBytes: 16 * 1024 * 1024,
    globalMaxBytes: 64 * 1024 * 1024,
    queryLimitDefault: 100,
    queryLimitMax: 1_000,
    responseMaxBytes: 512 * 1024,
    lineMaxBytes: 64 * 1024,
  });
  assert.deepEqual(LIMITS.reference, {
    queryMaxChars: 256,
    limitDefault: 10,
    limitMax: 50,
    onlineBudgetMs: 8_000,
  });
  assert.equal(LIMITS.settledHistoryMaxEntries, 100);
});
