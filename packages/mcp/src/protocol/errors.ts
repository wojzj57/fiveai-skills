import { z } from "zod";

/**
 * Structured tool/business error contract (RFC §6.4).
 *
 * Protocol-level errors are handled by the MCP SDK; these codes cover known
 * validation and business failures surfaced through isError=true responses.
 * Terminal-state errors whose side effects are unknown must carry
 * sideEffectsUnknown=true and retrySafe=false.
 */

export const ERROR_CODES = [
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

/**
 * Error states where the task's remote side effects cannot be determined
 * (RFC §6.4: unknown 错误必须附 sideEffectsUnknown=true 和 retrySafe=false).
 */
export const UNKNOWN_OUTCOME_CODES: readonly ErrorCode[] = [
  "TIMEOUT_UNKNOWN",
  "CONNECTION_LOST_UNKNOWN",
];

/**
 * Whether an error code marks a broker-observed unknown outcome (RFC §6.4).
 * Such codes describe states the broker could not verify — they never appear
 * on bridge-reported terminal results and only attach to the `unknown` task
 * state (review F3).
 */
export function isUnknownOutcomeCode(
  code: string,
): code is (typeof UNKNOWN_OUTCOME_CODES)[number] {
  return (UNKNOWN_OUTCOME_CODES as readonly string[]).includes(code);
}

export const StructuredErrorSchema = z
  .strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1),
    /** Recoverable stack trace when the executor can provide one. */
    stack: z.string().optional(),
    sideEffectsUnknown: z.boolean().optional(),
    retrySafe: z.boolean().optional(),
  })
  .superRefine((error, ctx) => {
    if (!UNKNOWN_OUTCOME_CODES.includes(error.code)) return;
    if (error.sideEffectsUnknown !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["sideEffectsUnknown"],
        message: `${error.code} must carry sideEffectsUnknown=true`,
      });
    }
    if (error.retrySafe !== false) {
      ctx.addIssue({
        code: "custom",
        path: ["retrySafe"],
        message: `${error.code} must carry retrySafe=false`,
      });
    }
  });

export type StructuredError = z.infer<typeof StructuredErrorSchema>;
