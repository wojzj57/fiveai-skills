import { z } from "zod";
import { IsoUtcSchema, UuidSchema } from "./ids.ts";
import { TargetRefSchema } from "./messages.ts";
import { LIMITS } from "./limits.ts";

/**
 * recovery.json contract (RFC §7.2, design §3.3). The record is written
 * atomically (temp file, flush, same-directory rename) before any dispatch
 * and after any verified terminal state. It deliberately stores NO code,
 * SQL, bound parameters, or full results — the strict object shape enforces
 * that absence at the schema level.
 */

/** Tool categories with distinct recovery semantics (RFC §7.4). */
export const RECOVERY_TOOL_CATEGORIES = [
  "execution",
  "framework",
  "ox",
  "resource",
] as const;
export type RecoveryToolCategory =
  (typeof RECOVERY_TOOL_CATEGORIES)[number];

/**
 * Dispatch intent: written before task.dispatch is sent. Any crash after
 * this record exists is recovered as "may have been dispatched" (RFC §7.2).
 * The target's epoch binding is the clientEpoch inside `target`; the
 * bridge's own generation is identified through the authenticated bridge
 * connection when a late terminal report arrives, not persisted here.
 */
export const DispatchIntentRecordSchema = z.strictObject({
  kind: z.literal("dispatch_intent"),
  taskId: UuidSchema,
  brokerInstanceId: UuidSchema,
  target: TargetRefSchema,
  toolCategory: z.enum(RECOVERY_TOOL_CATEGORIES),
  createdAt: IsoUtcSchema,
});

/** Persisted terminal summary kept after resultAck (RFC §7.2/§7.3). */
export const SettledRecordSchema = z.strictObject({
  kind: z.literal("settled"),
  taskId: UuidSchema,
  brokerInstanceId: UuidSchema,
  state: z.enum(["succeeded", "failed"]),
  settledAt: IsoUtcSchema,
  /** Stable digest of the normalized terminal record. */
  resultDigest: z.string().min(1),
});

export const RecoveryFileSchema = z.strictObject({
  version: z.literal(1),
  brokerInstanceId: UuidSchema,
  /** At most one in-flight task needs persistence (RFC §7.2). */
  pending: DispatchIntentRecordSchema.nullable(),
  history: z.array(SettledRecordSchema).max(
    LIMITS.settledHistoryMaxEntries,
  ),
});

export type DispatchIntentRecord = z.infer<typeof DispatchIntentRecordSchema>;
export type SettledRecord = z.infer<typeof SettledRecordSchema>;
export type RecoveryFile = z.infer<typeof RecoveryFileSchema>;
