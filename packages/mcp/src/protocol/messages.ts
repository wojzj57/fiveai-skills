import { z } from "zod";
import { DurationMsSchema, EpochSchema, IsoUtcSchema, PlayerIdSchema, UuidSchema } from "./ids.ts";
import { StructuredErrorSchema, isUnknownOutcomeCode } from "./errors.ts";
import { BoundedExecutionValueSchema } from "./wire-value.ts";
import { LIMITS } from "./limits.ts";
import { ControlToolSchema, FifoToolSchema } from "./tool-names.ts";
import {
  ARGS_JSON_BOUNDS,
  MESSAGE_ARGUMENTS_JSON_BOUNDS,
  CONTROL_RESULT_JSON_BOUNDS,
  boundedJson,
} from "./json-bounds.ts";
import { ResourceInputSchema, ResourceNameSchema } from "../tools/schemas.ts";

/**
 * v1 internal message payload contracts (RFC §5.1 message table). The
 * envelope (v/id/type/brokerInstanceId/sessionId/payload) is defined in
 * envelope.ts; these schemas describe each payload. Runtime wiring for
 * messages belongs to later implementation steps — this module only fixes
 * the wire contract.
 */

/**
 * Bounded JSON field for a complete tool input submitted through an internal
 * message (completeness review F3): the iterative guard budgets the tool
 * input wrapper on top of the business args; the tool schema remains the
 * authority for the args themselves.
 */
const BoundedArgumentsSchema = boundedJson(MESSAGE_ARGUMENTS_JSON_BOUNDS);

/** Bounded JSON field for raw approval parameters (no tool-input wrapper). */
const BoundedParametersSchema = boundedJson(ARGS_JSON_BOUNDS);

/** Task lifecycle states (design §6.1). */
export const TASK_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type TaskState = (typeof TASK_STATES)[number];
export const TaskStateSchema = z.enum(TASK_STATES);

/**
 * Execution target identity (RFC §5.1/§5.2). Server targets carry no client
 * binding; client targets bind both the server ID and the clientEpoch so a
 * reused server ID can never receive an old task.
 */
export const TargetRefSchema = z.discriminatedUnion("side", [
  z.strictObject({ side: z.literal("server") }),
  z.strictObject({
    side: z.literal("client"),
    clientId: PlayerIdSchema,
    clientEpoch: EpochSchema,
  }),
]);
export type TargetRef = z.infer<typeof TargetRefSchema>;

/**
 * Execution environment identity reported by a Server bridge connection
 * (RFC §5.2, review F2): the bridge's own generation plus the FXServer
 * process identity it runs in. bridgeEpoch is NOT the server lifecycle —
 * pid + startedAt are. When serverIdentityVerifiable is false the identity
 * cannot anchor the RFC §7.4 environment-recovery exception.
 */
export const BridgeEnvironmentSchema = z.strictObject({
  bridgeEpoch: EpochSchema,
  serverPid: z.number().int().positive(),
  serverStartedAt: IsoUtcSchema,
  serverIdentityVerifiable: z.boolean(),
});
export type BridgeEnvironment = z.infer<typeof BridgeEnvironmentSchema>;

/** hello / welcome — connection handshake (RFC §5.1, §4.3, §5.2). */
export const HelloSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("entry"),
    internalProtocol: z.literal(1),
    buildId: z.string().min(1),
    configDigest: z.string().min(1),
  }),
  z.strictObject({
    role: z.literal("bridge"),
    internalProtocol: z.literal(1),
    buildId: z.string().min(1),
    adapterDigest: z.string().min(1),
    environment: BridgeEnvironmentSchema,
  }),
]);
export type Hello = z.infer<typeof HelloSchema>;

export const WelcomeSchema = z.strictObject({
  brokerInstanceId: UuidSchema,
  sessionId: UuidSchema,
  capacity: z.strictObject({
    maxQueued: z.number().int().positive(),
    maxRunningOrUnknown: z.number().int().positive(),
    maxPendingApprovalsPerEntry: z.number().int().positive(),
    frameMaxBytes: z.number().int().positive(),
  }),
});
export type Welcome = z.infer<typeof WelcomeSchema>;

/** ping / pong — heartbeat; never changes task state (RFC §4.3, §5.1). */
export const PingSchema = z.strictObject({ nonce: z.string().min(1) });
export const PongSchema = z.strictObject({ nonce: z.string().min(1) });

/** task.submit / task.accepted — entry → broker and back (RFC §5.1). */
export const TaskSubmitSchema = z
  .strictObject({
    /** Only FIFO-routed tools enter task.submit; read/control tools use control.request. */
    tool: FifoToolSchema,
    /** Already-validated tool arguments (validated against the tool schema). */
    arguments: BoundedArgumentsSchema,
    requestId: UuidSchema,
  })
  .superRefine((submit, ctx) => {
    if (submit.tool === "resource" && looksLikeResourceReadArguments(submit.arguments)) {
      ctx.addIssue({
        code: "custom",
        path: ["tool"],
        message:
          "resource list/status reads never enter the FIFO (RFC §11); they ride the control channel and bridge.read.request",
      });
    }
  });

export const TaskAcceptedSchema = z.strictObject({
  taskId: UuidSchema,
  /** Sequence assigned when the valid request enters the global FIFO. */
  sequence: z.number().int().positive(),
  state: TaskStateSchema,
});

/** task.dispatch / task.received — broker → bridge and back (RFC §5.1). */
export const TaskDispatchSchema = z
  .strictObject({
    taskId: UuidSchema,
    target: TargetRefSchema,
    /** Only FIFO-routed tools are dispatched to executors. */
    tool: FifoToolSchema,
    arguments: BoundedArgumentsSchema,
    /** Absolute deadline for timeoutMs observation, monotonic clock ms. */
    deadlineMs: z.number().int().positive(),
    timeoutMs: z.number().int().min(1),
  })
  .superRefine((dispatch, ctx) => {
    if (dispatch.tool === "resource" && looksLikeResourceReadArguments(dispatch.arguments)) {
      ctx.addIssue({
        code: "custom",
        path: ["tool"],
        message: "resource list/status reads are not dispatched through the FIFO (RFC §11)",
      });
    }
  });

/**
 * True for argument SHAPES that look like resource reads — used to keep any
 * read-shaped payload out of the FIFO, even an otherwise invalid one. The
 * strict validator for the control channel is {@link isResourceReadArguments}.
 */
function looksLikeResourceReadArguments(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const action = (args as { action?: unknown }).action;
  return action === "list" || action === "status";
}

/**
 * True for arguments that fully validate as resource list/status reads
 * (RFC §11, review F4): the shape both control channels accept.
 */
export function isResourceReadArguments(args: unknown): boolean {
  const parsed = ResourceInputSchema.safeParse(args);
  return (
    parsed.success &&
    (parsed.data.action === "list" || parsed.data.action === "status")
  );
}

export const TaskReceivedSchema = z.strictObject({
  taskId: UuidSchema,
});

/**
 * Completion evidence carried by failed results (RFC §6.3, §8, review F3).
 * Serialization failures report executionCompleted=true — the remote
 * function ended, the queue may advance. Compile failures report
 * executionCompleted=false with noRemoteExecution=true — the code never ran
 * remotely, so ending the task is safe.
 */
export const FailureEvidenceSchema = z.strictObject({
  /** Whether the reporting side can definitively state the function ended. */
  executionCompleted: z.boolean(),
  /** True when the fragment never started executing on a remote runtime. */
  noRemoteExecution: z.boolean(),
});
export type FailureEvidence = z.infer<typeof FailureEvidenceSchema>;

/**
 * Shared completion-evidence rules for every failed payload, direct
 * (task.result) and queried (task.statusResult) alike (completeness review
 * F2). A failed terminal must prove one of:
 * - the remote function ended (`executionCompleted=true`) — the queue may
 *   advance; or
 * - the fragment never started remotely (`noRemoteExecution=true`) — ending
 *   the task is safe because nothing executed.
 *
 * `false/false` proves neither and `true/true` is contradictory, so both are
 * rejected. Stage-specific codes pin the exact legal combination: compiler
 * errors happen before execution, execution errors mean the function ran and
 * ended, and serialization failures mean it already ended (RFC §6.3, §8).
 * Returns the rejection message, or null when the evidence is legal.
 */
export function failureEvidenceIssue(
  code: string,
  evidence: FailureEvidence,
): string | null {
  const { executionCompleted, noRemoteExecution } = evidence;
  if (!executionCompleted && !noRemoteExecution) {
    return "failed terminals must prove executionCompleted or noRemoteExecution (RFC §8)";
  }
  if (executionCompleted && noRemoteExecution) {
    return "executionCompleted and noRemoteExecution are mutually exclusive";
  }
  if (code === "COMPILATION_ERROR") {
    return executionCompleted === false && noRemoteExecution === true
      ? null
      : "COMPILATION_ERROR must report executionCompleted=false and noRemoteExecution=true (RFC §8)";
  }
  if (code === "EXECUTION_ERROR") {
    return executionCompleted === true
      ? null
      : "EXECUTION_ERROR means the function ran and ended: executionCompleted=true (RFC §8)";
  }
  if (code === "RESULT_UNSERIALIZABLE" || code === "RESULT_TOO_LARGE") {
    return executionCompleted === true
      ? null
      : `${code} means the remote function already ended: executionCompleted=true (RFC §6.3)`;
  }
  return null;
}

/**
 * task.result — bridge → broker → entry (RFC §5.1, §6.3). Only terminal
 * outcomes are reported; `unknown` is a broker-observed state and never a
 * bridge report — failed results therefore reject the unknown-outcome error
 * codes (review F3). succeeded carries a result, failed carries an error
 * plus completion evidence.
 *
 * The report identifies its execution environment (`executedBy`) so the
 * broker can match late reports against the persisted dispatch intent
 * across restarts (review F2). Late reports across a broker restart carry
 * originalBrokerInstanceId as well; the field is optional at the schema
 * level because same-generation reports identify through the envelope.
 */
export const TaskResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    taskId: UuidSchema,
    target: TargetRefSchema,
    executedBy: BridgeEnvironmentSchema,
    state: z.literal("succeeded"),
    result: BoundedExecutionValueSchema,
    queuedMs: DurationMsSchema,
    executionMs: DurationMsSchema,
    originalBrokerInstanceId: UuidSchema.optional(),
  }),
  z
    .strictObject({
      taskId: UuidSchema,
      target: TargetRefSchema,
      executedBy: BridgeEnvironmentSchema,
      state: z.literal("failed"),
      error: StructuredErrorSchema,
      evidence: FailureEvidenceSchema,
      queuedMs: DurationMsSchema,
      executionMs: DurationMsSchema,
      originalBrokerInstanceId: UuidSchema.optional(),
    })
    .superRefine((failure, ctx) => {
      if (isUnknownOutcomeCode(failure.error.code)) {
        ctx.addIssue({
          code: "custom",
          path: ["error"],
          message: `${failure.error.code} is a broker-observed unknown state, never a bridge-reported terminal result (RFC §6.2)`,
        });
        return;
      }
      const issue = failureEvidenceIssue(failure.error.code, failure.evidence);
      if (issue !== null) {
        ctx.addIssue({ code: "custom", path: ["evidence"], message: issue });
      }
    }),
]);
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** task.resultAck — broker → bridge: result persisted, may be released (RFC §7.3). */
export const TaskResultAckSchema = z.strictObject({
  taskId: UuidSchema,
});

export const TaskStatusQuerySchema = z.strictObject({
  taskId: UuidSchema,
});

/**
 * task.status / task.statusResult — query an existing task without code and
 * without retrying (RFC §5.1, §7.3). The payload combinations are
 * discriminated by state (review F3):
 * - succeeded: resultAvailable must equal the presence of `result`; error
 *   and evidence are never carried;
 * - failed: resultAvailable must equal the presence of `error`, and
 *   evidence accompanies the error; unknown-outcome codes never appear
 *   (they cannot be verified terminals);
 * - unknown: resultAvailable is false; an optional error must be one of the
 *   broker-observation codes (TIMEOUT_UNKNOWN / CONNECTION_LOST_UNKNOWN);
 * - queued / running / cancelled: resultAvailable is false and no terminal
 *   payload is carried.
 */
export const TaskStatusResultSchema = z
  .strictObject({
    taskId: UuidSchema,
    state: TaskStateSchema,
    /** True only while the full terminal payload is retained. */
    resultAvailable: z.boolean(),
    result: BoundedExecutionValueSchema.optional(),
    error: StructuredErrorSchema.optional(),
    evidence: FailureEvidenceSchema.optional(),
    queuedMs: DurationMsSchema.optional(),
    executionMs: DurationMsSchema.optional(),
  })
  .superRefine((status, ctx) => {
    const add = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    const hasResult = status.result !== undefined;
    const hasError = status.error !== undefined;
    const hasEvidence = status.evidence !== undefined;
    switch (status.state) {
      case "succeeded":
        if (hasError || hasEvidence) {
          add("error", "succeeded carries no error or evidence");
        }
        if (status.resultAvailable !== hasResult) {
          add(
            "resultAvailable",
            "succeeded: resultAvailable must equal the presence of result",
          );
        }
        break;
      case "failed":
        if (hasResult) {
          add("result", "failed carries no result value");
        }
        if (status.resultAvailable !== hasError) {
          add(
            "resultAvailable",
            "failed: resultAvailable must equal the presence of error",
          );
        }
        if (hasError !== hasEvidence) {
          add(
            "evidence",
            "failed: error and evidence appear together",
          );
        }
        if (
          hasError &&
          status.error !== undefined &&
          isUnknownOutcomeCode(status.error.code)
        ) {
          add(
            "error",
            "unknown-outcome codes never mark a verified failed terminal",
          );
        }
        // The same stage/evidence matrix as direct task.result reports
        // (completeness review F2): a reconnection status query cannot
        // accept evidence the direct path would reject.
        if (
          hasError &&
          hasEvidence &&
          status.error !== undefined &&
          status.evidence !== undefined
        ) {
          const issue = failureEvidenceIssue(
            status.error.code,
            status.evidence,
          );
          if (issue !== null) {
            add("evidence", issue);
          }
        }
        break;
      case "unknown":
        if (status.resultAvailable) {
          add("resultAvailable", "unknown never retains a full payload");
        }
        if (hasResult || hasEvidence) {
          add("result", "unknown carries no result or evidence");
        }
        if (
          hasError &&
          status.error !== undefined &&
          !isUnknownOutcomeCode(status.error.code)
        ) {
          add(
            "error",
            "unknown observation errors are TIMEOUT_UNKNOWN / CONNECTION_LOST_UNKNOWN",
          );
        }
        break;
      default:
        // queued, running, cancelled
        if (status.resultAvailable) {
          add("resultAvailable", "non-terminal states never retain payloads");
        }
        if (hasResult || hasError || hasEvidence) {
          add("result", "non-terminal states carry no terminal payloads");
        }
        break;
    }
  });

/**
 * approval.request / approval.result — broker ↔ original entry for oxmysql
 * write confirmation (RFC §10.2). The request binds method, SQL, parameters,
 * and session identities; the digest covers the normalized form while `sql`
 * stays verbatim for display and execution.
 */
export const ApprovalRequestSchema = z.strictObject({
  approvalId: UuidSchema,
  digest: z.string().min(1),
  method: z.string().min(1),
  sql: z.string().min(1),
  parameters: BoundedParametersSchema,
  serverEpoch: EpochSchema,
  bridgeEpoch: EpochSchema,
  entrySessionId: UuidSchema,
  /** Links back to the originating tool call. */
  requestId: UuidSchema,
});

export const ApprovalResultSchema = z
  .strictObject({
    approvalId: UuidSchema,
    digest: z.string().min(1),
    action: z.enum(["accept", "decline", "cancel"]),
    /** Only action=accept with confirm=true constitutes approval (RFC §10.2). */
    confirm: z.boolean().optional(),
  })
  .superRefine((approval, ctx) => {
    if (approval.action === "accept" && approval.confirm !== true) {
      ctx.addIssue({
        code: "custom",
        path: ["confirm"],
        message: "action=accept requires confirm=true",
      });
    }
  });

/** Structured log record carried by logs.batch (RFC §12.3). */
export const LogRecordSchema = z.strictObject({
  logId: z.string().min(1),
  source: z.enum(["server", "client", "forwarded-server"]),
  streamId: z.string().min(1),
  sequence: z.number().int().min(0),
  clientEpoch: EpochSchema.optional(),
  observedAt: IsoUtcSchema,
  /** Empty (null or omitted) when the original occurrence time is unobtainable (RFC §12.3). */
  sourceTime: IsoUtcSchema.nullable().optional(),
  channel: z.string().min(1).optional(),
  /**
   * Unknown attribution is represented explicitly: RFC §12.1 says
   * resource=null for channels that cannot be mapped to a resource. The
   * encoder may use null or omit the field; both wire forms are accepted.
   */
  resource: z.string().min(1).nullable().optional(),
  /** May be an empty line produced by splitting a multi-line console message (RFC §12.1). */
  message: z.string(),
  raw: z.string().optional(),
  truncated: z.boolean(),
});

export const LogsBatchSchema = z.strictObject({
  streamId: z.string().min(1),
  sequence: z.number().int().min(0),
  records: z.array(LogRecordSchema).max(LIMITS.message.logsBatchMaxRecords),
  droppedCount: z.number().int().min(0),
});

/** clients.snapshot — current client bindings (RFC §5.1, §5.2). */
export const ClientBindingSchema = z.strictObject({
  serverId: PlayerIdSchema,
  clientEpoch: EpochSchema,
  capabilities: z.array(z.string().min(1)),
  logMarker: z.string().min(1),
});

export const ClientsSnapshotSchema = z.strictObject({
  bridgeEpoch: EpochSchema,
  clients: z.array(ClientBindingSchema),
});

/**
 * control.request / control.result — entry ↔ broker channel for status,
 * queue, logs, reference, and resource reads (RFC §5.1, §11, review F4).
 * Independent of the FIFO: these requests keep working while the execution
 * queue is paused. The `resource` tool is restricted to list/status
 * arguments here; start/stop/restart mutations enter the FIFO via
 * task.submit and are dispatched to the bridge like other executions.
 */
export const ControlRequestSchema = z
  .strictObject({
    requestId: UuidSchema,
    /** Only control/read tools ride this channel (RFC §5.1). */
    tool: ControlToolSchema,
    arguments: BoundedArgumentsSchema,
  })
  .superRefine((request, ctx) => {
    if (request.tool !== "resource") return;
    if (!isResourceReadArguments(request.arguments)) {
      ctx.addIssue({
        code: "custom",
        path: ["arguments"],
        message:
          "resource rides the control channel for list/status reads only (RFC §11); start/stop/restart enter the FIFO",
      });
    }
  });

export const ControlResultSchema = z
  .strictObject({
    requestId: UuidSchema,
    /**
     * Depth-bounded only (review F5): logs responses may legitimately carry
     * more than 10,000 nodes; their size is governed by the RFC §6.2
     * response byte caps and the frame limit.
     */
    result: boundedJson(CONTROL_RESULT_JSON_BOUNDS).optional(),
    error: StructuredErrorSchema.optional(),
  })
  .superRefine((response, ctx) => {
    const hasResult = response.result !== undefined;
    const hasError = response.error !== undefined;
    if (hasResult === hasError) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of result or error must be present",
      });
    }
  });

/**
 * Tools whose reads the broker forwards to the bridge control channel
 * (RFC §11, review F4): served outside the execution FIFO and available
 * while the queue is paused.
 */
export const BRIDGE_READ_TOOLS = ["resource"] as const;
export type BridgeReadTool = (typeof BRIDGE_READ_TOOLS)[number];
export const BridgeReadToolSchema = z.enum(BRIDGE_READ_TOOLS);

/** bridge.read.request — broker → bridge control-channel read (RFC §11, review F4). */
export const BridgeReadRequestSchema = z
  .strictObject({
    requestId: UuidSchema,
    tool: BridgeReadToolSchema,
    arguments: BoundedArgumentsSchema,
  })
  .superRefine((request, ctx) => {
    if (request.tool === "resource" && !isResourceReadArguments(request.arguments)) {
      ctx.addIssue({
        code: "custom",
        path: ["arguments"],
        message: "bridge resource reads accept list/status arguments only (RFC §11)",
      });
    }
  });

/**
 * Result payload of a bridge-served resource read (RFC §11). `source`
 * distinguishes a live read from the bridge/broker cache — a cache entry
 * must never be marked live while the server is unresponsive.
 */
export const ResourceReadResultSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("list"),
    source: z.enum(["live", "cached"]),
    resources: z.array(
      z.strictObject({
        name: ResourceNameSchema,
        /** FiveM resource state as reported by GetResourceState. */
        state: z.string().min(1),
      }),
    ),
  }),
  z.strictObject({
    action: z.literal("status"),
    source: z.enum(["live", "cached"]),
    name: ResourceNameSchema,
    state: z.string().min(1),
  }),
]);

/** bridge.read.result — bridge → broker reply for a control-channel read (RFC §11). */
export const BridgeReadResultSchema = z
  .strictObject({
    requestId: UuidSchema,
    result: ResourceReadResultSchema.optional(),
    error: StructuredErrorSchema.optional(),
  })
  .superRefine((response, ctx) => {
    const hasResult = response.result !== undefined;
    const hasError = response.error !== undefined;
    if (hasResult === hasError) {
      ctx.addIssue({
        code: "custom",
        message: "exactly one of result or error must be present",
      });
    }
  });
