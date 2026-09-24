export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type TaskTool = "execute_lua" | "execute_js" | "resource" | "esx" | "qbcore" | "ox";
export type TaskState = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type TaskPhase =
  | "validation"
  | "confirmation"
  | "queued"
  | "preparing"
  | "waiting_host"
  | "dispatched"
  | "settled"
  | "read"
  | "recovery";
export type TaskExecution = "not_dispatched" | "ended" | "unknown" | "not_applicable";

export type TaskErrorCode =
  | "INPUT_TOO_LARGE"
  | "INPUT_TOO_COMPLEX"
  | "CONFIRMATION_LIMIT"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_UNSUPPORTED"
  | "CONFIRMATION_TOO_LARGE"
  | "CONFIRMATION_DECLINED"
  | "CONFIRMATION_CANCELLED"
  | "QUEUE_FULL"
  | "QUEUE_EXPIRED"
  | "TARGET_UNAVAILABLE"
  | "TARGET_CHANGED"
  | "TASK_NOT_FOUND"
  | "TASK_NOT_CANCELLABLE"
  | "TASK_ALREADY_FINISHED"
  | "TASK_NOT_UNKNOWN"
  | "RECOVERY_UNPROVEN"
  | "HOST_UNAVAILABLE"
  | "JAVASCRIPT_INVALID"
  | "COMPILE_FAILED"
  | "PREPARATION_TIMEOUT"
  | "EXECUTION_FAILED"
  | "EXECUTION_UNKNOWN"
  | "RESULT_TOO_LARGE"
  | "RESULT_UNSUPPORTED"
  | "DEPENDENCY_MISSING"
  | "DEPENDENCY_VERSION_UNSUPPORTED"
  | "METHOD_UNSUPPORTED"
  | "RESOURCE_BUSY"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_OPERATION_FAILED"
  | "SELF_RESOURCE_PROTECTED"
  | "LOG_SOURCE_UNAVAILABLE"
  | "REFERENCE_UNAVAILABLE"
  | "INTERNAL_ERROR"
  | "SESSION_ENDED"
  | "TASK_CANCELLED"
  | "EXECUTOR_FULL";

export interface TaskError {
  code: TaskErrorCode;
  message: string;
  phase: TaskPhase;
  retryable: boolean;
  execution: TaskExecution;
  stack?: string;
  details?: JsonValue;
}

export interface ServerBinding {
  resourceEpoch: string;
  side: "server";
}

export interface ClientBinding {
  resourceEpoch: string;
  side: "client";
  clientId: number;
  connectionId: string;
  clientEpoch: string;
}

export type TaskBinding = ServerBinding | ClientBinding;

export interface TaskTarget {
  binding: TaskBinding;
  resource?: string;
  dependencyEpoch?: string;
  playerId?: number;
  playerConnectionId?: string;
}

export type WireValue = JsonValue;

export type ResourceState =
  | "missing"
  | "uninitialized"
  | "starting"
  | "started"
  | "stopping"
  | "stopped"
  | "unknown";

export interface ResourceStage {
  action: "start" | "stop";
  before: ResourceState;
  after: ResourceState;
  ok: boolean;
  error?: TaskError;
}

export interface ResourceChange {
  name: string;
  before: ResourceState;
  after: ResourceState;
  stages: ResourceStage[];
}

export type TaskResult =
  | { kind: "values"; values: WireValue[] }
  | { kind: "resource"; change: JsonValue };

export interface TaskSnapshot {
  taskId: string;
  sequence: string;
  tool: TaskTool;
  state: TaskState;
  phase: TaskPhase;
  target: TaskTarget;
  createdAt: string;
  queueMs: number;
  executionMs: number;
  execution: TaskExecution;
  dispatchedAt?: string;
  endedAt?: string;
  result?: TaskResult;
  error?: TaskError;
}

export interface TaskSummary {
  taskId: string;
  sequence: string;
  tool: TaskTool;
  state: TaskState;
  phase: TaskPhase;
  target: TaskTarget;
  createdAt: string;
  errorCode?: TaskErrorCode;
}

export interface QueueOverview {
  paused: boolean;
  blockingTaskId: string | null;
  active: TaskSnapshot | null;
  queued: TaskSummary[];
  recent: TaskSummary[];
  retainedCount: number;
  evictedCount: number;
}

export interface TaskClock {
  monotonic(): number;
  wall(): string;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface TaskSubmitRequest {
  sessionId: string;
  tool: TaskTool;
  target: TaskTarget;
  payload: unknown;
  timeoutMs?: number;
}

export type TaskOperationResult =
  | { ok: true; task: TaskSnapshot }
  | { ok: false; error: TaskError; task?: TaskSnapshot };

export type PrepareOutcome<TPrepared = unknown> =
  | { ok: true; value: TPrepared }
  | { ok: false; error: TaskError };

export interface PrepareContext {
  taskId: string;
  task: TaskSnapshot;
  payload: unknown;
  signal: AbortSignal;
}

export interface SettleEvidence {
  identity: TaskBinding | Record<string, unknown>;
  execution: "not_dispatched" | "ended" | "unknown";
  result?: TaskResult;
  error?: TaskError | Record<string, unknown>;
}

export type SettleResult =
  | { accepted: true; task: TaskSnapshot }
  | {
      accepted: false;
      reason: "not_found" | "identity_mismatch" | "invalid_evidence" | "duplicate" | "conflict";
      task?: TaskSnapshot;
    };

export interface DispatchContext<TPrepared = unknown> {
  taskId: string;
  task: TaskSnapshot;
  prepared: TPrepared;
  signal: AbortSignal;
  dispatchCommitted(): boolean;
  settle(evidence: SettleEvidence): SettleResult;
}

export interface RecoverContext {
  taskId: string;
  task: TaskSnapshot;
  signal: AbortSignal;
}

export interface CommitValidationContext {
  taskId: string;
  task: TaskSnapshot;
  prepared: unknown;
}

export interface TaskCenterOptions {
  sessionValid?: (sessionId: string) => boolean;
  resourceEpoch: string;
  clock?: TaskClock;
  yieldControl?: () => void | Promise<void>;
  prepare: (context: PrepareContext) => unknown | Promise<unknown>;
  dispatch: (context: DispatchContext) => void | Promise<void>;
  recover?: (context: RecoverContext) => SettleEvidence | null | Promise<SettleEvidence | null>;
  validateCommit?: (context: CommitValidationContext) => true | TaskError;
}
