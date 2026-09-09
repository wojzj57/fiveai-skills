import { z } from "zod";
import { DurationMsSchema, EpochSchema, IsoUtcSchema, PlayerIdSchema, UuidSchema } from "./ids.ts";
import { StructuredErrorSchema } from "./errors.ts";
import { ExecutionValueSchema } from "./wire-value.ts";
import { LIMITS } from "./limits.ts";
import { ControlToolSchema, FifoToolSchema } from "./tool-names.ts";

/**
 * v1 internal message payload contracts (RFC §5.1 message table). The
 * envelope (v/id/type/brokerInstanceId/sessionId/payload) is defined in
 * envelope.ts; these schemas describe each payload. Runtime wiring for
 * messages belongs to later implementation steps — this module only fixes
 * the wire contract.
 */

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

/** hello / welcome — connection handshake (RFC §5.1, §4.3). */
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
    arguments: z.json(),
    requestId: UuidSchema,
  })
  .superRefine((submit, ctx) => {
    if (submit.tool === "resource" && isResourceReadArguments(submit.arguments)) {
      ctx.addIssue({
        code: "custom",
        path: ["tool"],
        message:
          "resource list/status reads never enter the FIFO (RFC §11); their entry-side routing is defined by the resource-control slice",
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
    arguments: z.json(),
    /** Absolute deadline for timeoutMs observation, monotonic clock ms. */
    deadlineMs: z.number().int().positive(),
    timeoutMs: z.number().int().min(1),
  })
  .superRefine((dispatch, ctx) => {
    if (dispatch.tool === "resource" && isResourceReadArguments(dispatch.arguments)) {
      ctx.addIssue({
        code: "custom",
        path: ["tool"],
        message: "resource list/status reads are not dispatched through the FIFO (RFC §11)",
      });
    }
  });

/** True for `{tool:"resource", action:"list"|"status"}` argument shapes. */
function isResourceReadArguments(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const action = (args as { action?: unknown }).action;
  return action === "list" || action === "status";
}

export const TaskReceivedSchema = z.strictObject({
  taskId: UuidSchema,
});

/**
 * task.result — bridge → broker → entry (RFC §5.1, §6.3). Only terminal
 * outcomes are reported; `unknown` is a broker-observed state and never a
 * bridge report. succeeded carries a result, failed carries an error.
 *
 * Late terminal reports across a broker restart must carry
 * originalBrokerInstanceId plus the original target identity so the broker
 * can match them against the recovery record (RFC §5.1: 重连回报旧任务).
 * The field is optional at the schema level because same-generation reports
 * identify through the envelope; the runtime requires it for reconnect
 * reports.
 */
export const TaskResultSchema = z.discriminatedUnion("state", [
  z.strictObject({
    taskId: UuidSchema,
    target: TargetRefSchema,
    state: z.literal("succeeded"),
    result: ExecutionValueSchema,
    queuedMs: DurationMsSchema,
    executionMs: DurationMsSchema,
    originalBrokerInstanceId: UuidSchema.optional(),
  }),
  z.strictObject({
    taskId: UuidSchema,
    target: TargetRefSchema,
    state: z.literal("failed"),
    error: StructuredErrorSchema,
    queuedMs: DurationMsSchema,
    executionMs: DurationMsSchema,
    originalBrokerInstanceId: UuidSchema.optional(),
  }),
]);
export type TaskResult = z.infer<typeof TaskResultSchema>;

/** task.resultAck — broker → bridge: result persisted, may be released (RFC §7.3). */
export const TaskResultAckSchema = z.strictObject({
  taskId: UuidSchema,
});

/**
 * task.status / task.statusResult — query an existing task without code and
 * without retrying (RFC §5.1, §7.3).
 */
export const TaskStatusQuerySchema = z.strictObject({
  taskId: UuidSchema,
});

export const TaskStatusResultSchema = z
  .strictObject({
    taskId: UuidSchema,
    state: TaskStateSchema,
    /** False when only a summary remains after result retention expired. */
    resultAvailable: z.boolean(),
    result: ExecutionValueSchema.optional(),
    error: StructuredErrorSchema.optional(),
    queuedMs: DurationMsSchema.optional(),
    executionMs: DurationMsSchema.optional(),
  })
  .superRefine((status, ctx) => {
    if (!status.resultAvailable) return;
    const hasResult = status.result !== undefined;
    const hasError = status.error !== undefined;
    if (hasResult === hasError) {
      ctx.addIssue({
        code: "custom",
        message:
          "resultAvailable=true requires exactly one of result or error",
      });
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
  parameters: z.json(),
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
 * queue, logs, and reference tools (RFC §5.1). Independent of the FIFO:
 * these requests keep working while the execution queue is paused.
 */
export const ControlRequestSchema = z.strictObject({
  requestId: UuidSchema,
  /** Only broker-local control/read tools ride this channel (RFC §5.1). */
  tool: ControlToolSchema,
  arguments: z.json(),
});

export const ControlResultSchema = z
  .strictObject({
    requestId: UuidSchema,
    result: z.json().optional(),
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
