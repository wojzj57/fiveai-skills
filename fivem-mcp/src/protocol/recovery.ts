import { z } from "zod";
import { IsoUtcSchema, UuidSchema } from "./ids.ts";
import {
  BridgeEnvironmentSchema,
  TargetRefSchema,
  type BridgeEnvironment,
  type TargetRef,
} from "./messages.ts";
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
 * The record persists the execution environment identity (bridge generation
 * plus FXServer process identity, review F2) alongside the logical target,
 * so a restarted broker can verify that a late task.result really comes
 * from the original executor (RFC §7.4: 原执行器回报且身份匹配).
 */
export const DispatchIntentRecordSchema = z.strictObject({
  kind: z.literal("dispatch_intent"),
  taskId: UuidSchema,
  brokerInstanceId: UuidSchema,
  target: TargetRefSchema,
  environment: BridgeEnvironmentSchema,
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

/** Identity fields shared by every task.result report (both branches). */
export interface TaskResultIdentity {
  taskId: string;
  target: TargetRef;
  executedBy: BridgeEnvironment;
}

function sameTarget(a: TargetRef, b: TargetRef): boolean {
  if (a.side !== b.side) return false;
  if (a.side === "client" && b.side === "client") {
    return a.clientId === b.clientId && a.clientEpoch === b.clientEpoch;
  }
  return true;
}

function sameEnvironment(a: BridgeEnvironment, b: BridgeEnvironment): boolean {
  return (
    a.bridgeEpoch === b.bridgeEpoch &&
    a.serverPid === b.serverPid &&
    a.serverStartedAt === b.serverStartedAt &&
    a.serverIdentityVerifiable === b.serverIdentityVerifiable
  );
}

/**
 * Identity match between a persisted dispatch intent and a (possibly late)
 * task.result report (RFC §5.1, §7.4, review F2): the report settles the
 * recorded task only when the task id, the logical target, and the execution
 * environment all agree. A reused serverPid with a different
 * serverStartedAt (PID reuse), a new bridgeEpoch (bridge restart), or a
 * changed clientEpoch (server ID reuse) each break the match.
 *
 * This is the identity component of RFC §7.4 evidence only: callers using a
 * match to justify the environment-recovery exception must additionally
 * require environment.serverIdentityVerifiable === true, and a mismatched
 * report never disposes of the task on its own.
 */
export function matchesDispatchIntent(
  intent: DispatchIntentRecord,
  report: TaskResultIdentity,
): boolean {
  return (
    intent.taskId === report.taskId &&
    sameTarget(intent.target, report.target) &&
    sameEnvironment(intent.environment, report.executedBy)
  );
}
