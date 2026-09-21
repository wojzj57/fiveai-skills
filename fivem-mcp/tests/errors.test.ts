import assert from "node:assert/strict";
import test from "node:test";
import {
  ERROR_CODES,
  StructuredErrorSchema,
  UNKNOWN_OUTCOME_CODES,
} from "../src/protocol/errors.ts";

test("the error code list matches the RFC exactly, in order", () => {
  assert.deepEqual(ERROR_CODES, [
    "INVALID_ARGUMENT",
    "TARGET_UNAVAILABLE",
    "TARGET_AMBIGUOUS",
    "TARGET_SESSION_CHANGED",
    "FRAMEWORK_UNAVAILABLE",
    "METHOD_UNSUPPORTED",
    "PLAYER_NOT_FOUND",
    "QUEUE_FULL",
    "QUEUE_PAUSED",
    "TASK_NOT_FOUND",
    "TASK_NOT_CANCELLABLE",
    "TIMEOUT_UNKNOWN",
    "CONNECTION_LOST_UNKNOWN",
    "RECOVERY_EVIDENCE_REQUIRED",
    "STATE_STORE_ERROR",
    "COMPILATION_ERROR",
    "EXECUTION_ERROR",
    "RESULT_UNSERIALIZABLE",
    "RESULT_TOO_LARGE",
    "APPROVAL_UNSUPPORTED",
    "APPROVAL_DECLINED",
    "APPROVAL_CANCELLED",
    "APPROVAL_EXPIRED",
    "LOG_MAPPING_FAILED",
    "REFERENCE_UNAVAILABLE",
    "SELF_RESOURCE_PROTECTED",
  ]);
  assert.equal(ERROR_CODES.length, 26);
});

test("unknown-outcome errors must flag sideEffectsUnknown and retrySafe", () => {
  for (const code of UNKNOWN_OUTCOME_CODES) {
    assert.equal(
      StructuredErrorSchema.safeParse({ code, message: "m" }).success,
      false,
      `${code} without flags must be rejected`,
    );
    assert.equal(
      StructuredErrorSchema.safeParse({
        code,
        message: "m",
        sideEffectsUnknown: true,
        retrySafe: false,
      }).success,
      true,
    );
  }
  assert.equal(
    StructuredErrorSchema.safeParse({
      code: "INVALID_ARGUMENT",
      message: "m",
    }).success,
    true,
  );
  assert.equal(
    StructuredErrorSchema.safeParse({
      code: "NOT_A_CODE",
      message: "m",
    }).success,
    false,
  );
  assert.equal(
    StructuredErrorSchema.safeParse({
      code: "EXECUTION_ERROR",
      message: "m",
      stack: "stack trace",
      retrySafe: true,
    }).success,
    true,
  );
});
