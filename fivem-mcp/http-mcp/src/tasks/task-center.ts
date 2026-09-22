import contracts from "../shared/contracts.json" with {type:"json"};
import type {
  DispatchContext,
  JsonValue,
  PrepareContext,
  PrepareOutcome,
  QueueOverview,
  RecoverContext,
  SettleEvidence,
  SettleResult,
  TaskBinding,
  TaskCenterOptions,
  TaskClock,
  TaskError,
  TaskExecution,
  TaskOperationResult,
  TaskPhase,
  TaskSnapshot,
  TaskState,
  TaskSubmitRequest,
  TaskSummary,
  TaskTarget,
  TaskTool,
} from "./types.js";

const MAX_QUEUED = 128;
const MAX_QUEUED_PER_SESSION = 32;
const MAX_QUEUE_MS = 10 * 60 * 1_000;
const PREPARATION_BUDGET_MS = 5_000;
const HOST_WAIT_MS = 2_000;
const RECOVERY_WAIT_MS = 2_000;
const DEFAULT_EXECUTION_MS = 10_000;
const RESOURCE_EXECUTION_MS = 30_000;
const MIN_EXECUTION_MS = 100;
const MAX_EXECUTION_MS = 60_000;
const MAX_RESULT_BYTES = 256 * 1_024;
const MAX_TERMINALS = 256;
const MAX_TERMINAL_BYTES = 16 * 1_024 * 1_024;
const MAX_TERMINAL_MS = 10 * 60 * 1_000;
const RECENT_COUNT = 32;

interface InternalTask {
  taskId: string;
  sequence: string;
  sessionId: string;
  tool: TaskTool;
  state: TaskState;
  phase: TaskPhase;
  target: TaskTarget;
  createdAt: string;
  createdMono: number;
  startedMono?: number;
  committedMono?: number;
  endedMono?: number;
  dispatchedAt?: string;
  endedAt?: string;
  execution: TaskExecution;
  result?: TaskSnapshot["result"];
  error?: TaskError;
  payload?: unknown;
  prepared?: unknown;
  timeoutMs: number;
  queueDeadline: number;
  hostDeadline?: number;
  executionDeadline?: number;
  dispatchCommitted: boolean;
  abortController: AbortController;
  retainedAt?: number;
  retainedBytes?: number;
  terminalFingerprint?: string;
  unknownFingerprint?: string;
}

const encoder = new TextEncoder();

function defaultClock(): TaskClock {
  return {
    monotonic: () => (typeof performance === "undefined" ? Date.now() : performance.now()),
    wall: () => new Date().toISOString(),
    setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function bytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function isTerminal(state: TaskState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function bindingEquals(left: TaskBinding, right: TaskBinding): boolean {
  if (left.side !== right.side || left.resourceEpoch !== right.resourceEpoch) return false;
  if (left.side === "server" || right.side === "server") return left.side === right.side;
  return (
    left.clientId === right.clientId &&
    left.connectionId === right.connectionId &&
    left.clientEpoch === right.clientEpoch
  );
}

function isBinding(value: unknown): value is TaskBinding {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.resourceEpoch !== "string") return false;
  if (candidate.side === "server") return true;
  return (
    candidate.side === "client" &&
    typeof candidate.clientId === "number" &&
    typeof candidate.connectionId === "string" &&
    typeof candidate.clientEpoch === "string"
  );
}

function error(
  code: TaskError["code"],
  message: string,
  phase: TaskPhase,
  execution: TaskExecution,
  retryable = false,
): TaskError {
  return { code, message, phase, retryable, execution };
}

const ERROR_KEYS = new Set(["code", "message", "phase", "retryable", "execution", "stack", "details"]);
const RESOURCE_STATES = new Set(["missing", "uninitialized", "starting", "started", "stopping", "stopped", "unknown"]);
const EVIDENCE_EXECUTIONS = new Set(["not_dispatched", "ended", "unknown"]);

interface StructureBudget {
  nodes: number;
}

function dataRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== "string")) return undefined;
  if (Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) return undefined;
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], allowed = required): boolean {
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.includes(key));
}

function enterStructure(budget: StructureBudget, depth: number): boolean {
  budget.nodes += 1;
  return budget.nodes <= 10_000 && depth <= 32;
}

function validJsonValue(value: unknown, budget: StructureBudget, depth = 0): value is JsonValue {
  if (!enterStructure(budget, depth)) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 262_144;
  if (Array.isArray(value)) {
    return value.length <= 1_024 && value.every((item) => validJsonValue(item, budget, depth + 1));
  }
  const record = dataRecord(value);
  if (record === undefined) return false;
  const keys = Object.keys(record);
  return keys.length <= 1_024 && keys.every((key) => validJsonValue(record[key], budget, depth + 1));
}

function validError(value: unknown): value is TaskError {
  const e = dataRecord(value);
  if (e === undefined || !exactKeys(e, ["code", "message", "phase", "retryable", "execution"], [...ERROR_KEYS])) return false;
  if (!(contracts.$defs.ErrorCode.enum as readonly unknown[]).includes(e.code)) return false;
  if (!(contracts.$defs.Phase.enum as readonly unknown[]).includes(e.phase)) return false;
  if (!["not_dispatched", "ended", "unknown", "not_applicable"].includes(e.execution as string)) return false;
  if (typeof e.message !== "string" || e.message.length === 0 || e.message.length > 4_096) return false;
  if (typeof e.retryable !== "boolean") return false;
  if ((e.execution === "ended" || e.execution === "unknown") && e.retryable) return false;
  if (Object.hasOwn(e, "stack")) {
    if (typeof e.stack !== "string" || e.stack.length > 8_192 || encoder.encode(e.stack).byteLength > 8_192) return false;
  }
  if (Object.hasOwn(e, "details")) {
    if (!validJsonValue(e.details, { nodes: 0 }) || bytes(e.details) > MAX_RESULT_BYTES) return false;
  }
  return true;
}

function validWireValue(value: unknown, budget: StructureBudget, depth: number): boolean {
  if (!enterStructure(budget, depth)) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 262_144;
  if (Array.isArray(value)) {
    return value.length <= 1_024 && value.every((item) => validWireValue(item, budget, depth + 1));
  }
  const record = dataRecord(value);
  if (record === undefined) return false;
  const keys = Object.keys(record);
  if (keys.length > 1_024) return false;
  if (!Object.hasOwn(record, "$mcp")) {
    return keys.every((key) => key !== "$mcp" && validWireValue(record[key], budget, depth + 1));
  }
  const tag = record.$mcp;
  if ((tag === "nil" || tag === "undefined") && exactKeys(record, ["$mcp"])) return true;
  if (tag === "number" && exactKeys(record, ["$mcp", "value"])) {
    return record.value === "NaN" || record.value === "Infinity" || record.value === "-Infinity";
  }
  if (tag === "integer" && exactKeys(record, ["$mcp", "value"])) {
    return typeof record.value === "string" && record.value.length <= 262_144 && /^-?(0|[1-9][0-9]*)$/.test(record.value);
  }
  if (tag === "bytes" && exactKeys(record, ["$mcp", "base64"])) {
    return (
      typeof record.base64 === "string" &&
      record.base64.length <= 262_144 &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.base64)
    );
  }
  if (tag === "vector" && exactKeys(record, ["$mcp", "values"])) {
    if (!Array.isArray(record.values) || record.values.length < 2 || record.values.length > 4) return false;
    if (!enterStructure(budget, depth + 1)) return false;
    return record.values.every((item) => enterStructure(budget, depth + 2) && typeof item === "number" && Number.isFinite(item));
  }
  if ((tag === "table" || tag === "object") && exactKeys(record, ["$mcp", "entries"])) {
    if (!Array.isArray(record.entries) || record.entries.length > 1_024 || !enterStructure(budget, depth + 1)) return false;
    return record.entries.every((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || !enterStructure(budget, depth + 2)) return false;
      const key = entry[0];
      if (!enterStructure(budget, depth + 3)) return false;
      const validKey =
        tag === "object"
          ? typeof key === "string" && key.length <= 262_144
          : (typeof key === "string" && key.length <= 262_144) || typeof key === "boolean" || (typeof key === "number" && Number.isFinite(key));
      return validKey && validWireValue(entry[1], budget, depth + 3);
    });
  }
  return false;
}

function validResourceChange(value: unknown, budget: StructureBudget, depth: number): boolean {
  if (!enterStructure(budget, depth)) return false;
  const change = dataRecord(value);
  if (change === undefined || !exactKeys(change, ["name", "before", "after", "stages"])) return false;
  if (typeof change.name !== "string" || change.name.length === 0 || change.name.length > 128) return false;
  if (!RESOURCE_STATES.has(change.before as string) || !RESOURCE_STATES.has(change.after as string)) return false;
  if (!Array.isArray(change.stages) || change.stages.length < 1 || change.stages.length > 2) return false;
  if (!enterStructure(budget, depth + 1)) return false;
  return change.stages.every((stageValue) => {
    if (!enterStructure(budget, depth + 2)) return false;
    const stage = dataRecord(stageValue);
    if (stage === undefined || !exactKeys(stage, ["action", "before", "after", "ok"], ["action", "before", "after", "ok", "error"])) return false;
    if (stage.action !== "start" && stage.action !== "stop") return false;
    if (!RESOURCE_STATES.has(stage.before as string) || !RESOURCE_STATES.has(stage.after as string)) return false;
    if (typeof stage.ok !== "boolean") return false;
    return !Object.hasOwn(stage, "error") || validError(stage.error);
  });
}

function validTaskResult(value: unknown): value is NonNullable<TaskSnapshot["result"]> {
  const result = dataRecord(value);
  if (result === undefined || typeof result.kind !== "string") return false;
  const budget = { nodes: 0 };
  if (!enterStructure(budget, 0)) return false;
  if (result.kind === "values") {
    if (!exactKeys(result, ["kind", "values"]) || !Array.isArray(result.values) || result.values.length > 1_024) return false;
    if (!enterStructure(budget, 1)) return false;
    return result.values.every((item) => validWireValue(item, budget, 2));
  }
  if (result.kind === "resource") {
    return exactKeys(result, ["kind", "change"]) && validResourceChange(result.change, budget, 1);
  }
  return false;
}

function normalizeError(value: unknown, phase: TaskPhase, execution: TaskExecution): TaskError {
  if (validError(value)) {
    return clone(value as TaskError);
  }
  const message = value instanceof Error ? value.message : "task hook failed";
  return error("INTERNAL_ERROR", message || "task hook failed", phase, execution);
}

export class TaskCenter {
  readonly resourceEpoch: string;

  private readonly clock: TaskClock;
  private readonly yieldControl: NonNullable<TaskCenterOptions["yieldControl"]>;
  private readonly prepareHook: TaskCenterOptions["prepare"];
  private readonly dispatchHook: TaskCenterOptions["dispatch"];
  private readonly recoverHook: TaskCenterOptions["recover"];
  private readonly validateCommitHook: TaskCenterOptions["validateCommit"];
  private readonly tasks = new Map<string, InternalTask>();
  private readonly queue: string[] = [];
  private readonly terminalOrder: string[] = [];
  private readonly closedSessions = new Map<string,number>();
  private readonly sessionValidHook:TaskCenterOptions["sessionValid"];
  private readonly settlementWaiters = new Map<string, Set<() => void>>();
  private sequence = 0n;
  private activeId: string | null = null;
  private pipelineBusy = false;
  private stopped = false;
  private maintenanceTimer: unknown;
  private terminalBytes = 0;
  private evictedCount = 0;
  private protocolFaults = 0;
  private maintaining = false;

  constructor(options: TaskCenterOptions) {
    this.resourceEpoch = options.resourceEpoch;
    this.clock = options.clock ?? defaultClock();
    this.yieldControl = options.yieldControl ?? (() => Promise.resolve());
    this.sessionValidHook=options.sessionValid;
    this.prepareHook = options.prepare;
    this.dispatchHook = options.dispatch;
    this.recoverHook = options.recover;
    this.validateCommitHook = options.validateCommit;
  }

  submit(request: TaskSubmitRequest): TaskOperationResult {
    this.maintain();
    if (this.stopped || this.closedSessions.has(request.sessionId) || this.sessionValidHook?.(request.sessionId)===false) {
      return { ok: false, error: error("SESSION_ENDED", "session has ended", "validation", "not_dispatched") };
    }
    if (request.target.binding.resourceEpoch !== this.resourceEpoch) return {ok:false,error:error("TARGET_CHANGED","stale resource epoch","validation","not_dispatched")};
    const queuedForSession = this.queue.reduce((count, taskId) => {
      return count + (this.tasks.get(taskId)?.sessionId === request.sessionId ? 1 : 0);
    }, 0);
    if (this.queue.length >= MAX_QUEUED || queuedForSession >= MAX_QUEUED_PER_SESSION) {
      return { ok: false, error: error("QUEUE_FULL", "task queue is full", "queued", "not_dispatched", true) };
    }
    const requestedTimeout = request.timeoutMs ?? (request.tool === "resource" ? RESOURCE_EXECUTION_MS : DEFAULT_EXECUTION_MS);
    const timeoutMs = Math.min(MAX_EXECUTION_MS, Math.max(MIN_EXECUTION_MS, Math.trunc(requestedTimeout)));
    this.sequence += 1n;
    const sequence = this.sequence.toString();
    const now = this.clock.monotonic();
    const task: InternalTask = {
      taskId: `${this.resourceEpoch}:${sequence}`,
      sequence,
      sessionId: request.sessionId,
      tool: request.tool,
      state: "queued",
      phase: "queued",
      target: clone(request.target),
      createdAt: this.clock.wall(),
      createdMono: now,
      execution: "not_dispatched",
      payload: clone(request.payload),
      timeoutMs,
      queueDeadline: now + MAX_QUEUE_MS,
      dispatchCommitted: false,
      abortController: new AbortController(),
    };
    this.tasks.set(task.taskId, task);
    this.queue.push(task.taskId);
    this.scheduleMaintenance();
    this.kick();
    return { ok: true, task: this.snapshot(task) };
  }

  get(taskId: string): TaskSnapshot | undefined {
    this.maintain();
    const task = this.tasks.get(taskId);
    return task === undefined ? undefined : this.snapshot(task);
  }

  cancel(taskId: string): TaskOperationResult {
    this.maintain();
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return { ok: false, error: error("TASK_NOT_FOUND", "task was not found", "validation", "not_applicable") };
    }
    if (task.state === "cancelled") return { ok: true, task: this.snapshot(task) };
    if (isTerminal(task.state)) {
      return {
        ok: false,
        error: error("TASK_ALREADY_FINISHED", "task has already finished", "settled", "not_applicable"),
        task: this.snapshot(task),
      };
    }
    if (task.state === "unknown" || task.dispatchCommitted) {
      return {
        ok: false,
        error: error("TASK_NOT_CANCELLABLE", "task may already have executed", "dispatched", task.execution),
        task: this.snapshot(task),
      };
    }
    this.finish(task, "cancelled", undefined, error("TASK_CANCELLED", "task was cancelled", task.phase, "not_dispatched"));
    return { ok: true, task: this.snapshot(task) };
  }

  async recover(taskId: string): Promise<TaskOperationResult> {
    this.maintain();
    const task = this.tasks.get(taskId);
    if (task === undefined) {
      return { ok: false, error: error("TASK_NOT_FOUND", "task was not found", "recovery", "not_applicable") };
    }
    if (isTerminal(task.state)) return { ok: true, task: this.snapshot(task) };
    if (task.state !== "unknown") {
      return {
        ok: false,
        error: error("TASK_NOT_UNKNOWN", "task is not awaiting recovery", "recovery", task.execution),
        task: this.snapshot(task),
      };
    }
    if (this.recoverHook === undefined) return this.recoveryUnproven(task);

    const controller = new AbortController();
    let timeoutHandle: unknown;
    let removeWaiter = () => {};
    const timeout = new Promise<symbol>((resolve) => {
      timeoutHandle = this.clock.setTimer(() => resolve(Symbol.for("recovery-timeout")), RECOVERY_WAIT_MS);
    });
    const settled = new Promise<symbol>((resolve) => {
      const waiter = () => resolve(Symbol.for("task-settled"));
      let waiters = this.settlementWaiters.get(taskId);
      if (waiters === undefined) {
        waiters = new Set();
        this.settlementWaiters.set(taskId, waiters);
      }
      waiters.add(waiter);
      removeWaiter = () => {
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.settlementWaiters.delete(taskId);
      };
    });
    let evidence: SettleEvidence | null | symbol;
    try {
      const context: RecoverContext = { taskId, task: this.snapshot(task), signal: controller.signal };
      evidence = await Promise.race([Promise.resolve(this.recoverHook(context)), timeout, settled]);
    } catch {
      evidence = null;
    } finally {
      controller.abort();
      if (timeoutHandle !== undefined) this.clock.clearTimer(timeoutHandle);
      removeWaiter();
    }
    const current = this.tasks.get(taskId);
    if (current !== undefined && isTerminal(current.state)) return { ok: true, task: this.snapshot(current) };
    if (typeof evidence === "symbol" || evidence === null) return this.recoveryUnproven(task);
    const settledResult = this.settle(taskId, evidence);
    if (settledResult.accepted) return { ok: true, task: settledResult.task };
    const latest = this.tasks.get(taskId);
    if (latest !== undefined && isTerminal(latest.state)) return { ok: true, task: this.snapshot(latest) };
    return this.recoveryUnproven(task);
  }

  settle(taskId: string, evidence: SettleEvidence): SettleResult {
    this.maintain();
    const task = this.tasks.get(taskId);
    if (task === undefined) return { accepted: false, reason: "not_found" };
    if (!isBinding(evidence.identity) || !bindingEquals(task.target.binding, evidence.identity)) {
      this.protocolFaults += 1;
      return { accepted: false, reason: "identity_mismatch", task: this.snapshot(task) };
    }
    if (!EVIDENCE_EXECUTIONS.has(evidence.execution as string) || (evidence.result !== undefined && !validTaskResult(evidence.result))) {
      this.protocolFaults += 1;
      return { accepted: false, reason: "invalid_evidence", task: this.snapshot(task) };
    }
    if (evidence.error !== undefined && (!validError(evidence.error) || evidence.error.execution !== evidence.execution || (evidence.execution === "unknown" && evidence.error.phase !== "dispatched") || (evidence.execution === "ended" && !["dispatched","settled"].includes(evidence.error.phase)))) {
      this.protocolFaults += 1;
      return {accepted:false,reason:"invalid_evidence",task:this.snapshot(task)};
    }
    if (isTerminal(task.state)) {
      const fingerprint = JSON.stringify(evidence);
      const same = task.terminalFingerprint === fingerprint;
      if (!same) this.protocolFaults += 1;
      return { accepted: false, reason: same ? "duplicate" : "conflict", task: this.snapshot(task) };
    }
    if (evidence.execution === "unknown") {
      if (!task.dispatchCommitted || evidence.error === undefined || evidence.result !== undefined) {
        return { accepted: false, reason: "invalid_evidence", task: this.snapshot(task) };
      }
      const fingerprint = JSON.stringify(evidence);
      if (task.state === "unknown") {
        const same = task.unknownFingerprint === fingerprint;
        if (!same) this.protocolFaults += 1;
        return { accepted: false, reason: same ? "duplicate" : "conflict", task: this.snapshot(task) };
      }
      this.markUnknown(task, normalizeError(evidence.error, "dispatched", "unknown"), fingerprint);
      return { accepted: true, task: this.snapshot(task) };
    }
    if (evidence.execution === "not_dispatched") {
      if (evidence.error === undefined || evidence.result !== undefined) {
        return { accepted: false, reason: "invalid_evidence", task: this.snapshot(task) };
      }
      task.terminalFingerprint = JSON.stringify(evidence);
      this.finish(task, "failed", undefined, normalizeError(evidence.error, task.phase, "not_dispatched"), "not_dispatched");
      return { accepted: true, task: this.snapshot(task) };
    }
    if (!task.dispatchCommitted || (evidence.result === undefined) === (evidence.error === undefined)) {
      return { accepted: false, reason: "invalid_evidence", task: this.snapshot(task) };
    }
    task.terminalFingerprint = JSON.stringify(evidence);
    if (evidence.result !== undefined) {
      if (bytes(evidence.result) > MAX_RESULT_BYTES) {
        this.finish(
          task,
          "failed",
          undefined,
          error("RESULT_TOO_LARGE", "encoded task result exceeds 256KiB", "dispatched", "ended"),
        );
      } else {
        this.finish(task, "succeeded", clone(evidence.result));
      }
    } else {
      this.finish(task, "failed", undefined, normalizeError(evidence.error, "dispatched", "ended"));
    }
    return { accepted: true, task: this.snapshot(task) };
  }

  dispatchCommitted(taskId: string): boolean {
    this.maintain();
    const task = this.tasks.get(taskId);
    if (
      task === undefined ||
      task.state !== "running" ||
      task.phase !== "waiting_host" ||
      task.dispatchCommitted ||
      this.activeId !== taskId ||
      this.stopped ||
      this.closedSessions.has(task.sessionId)
    ) {
      return false;
    }
    if(this.sessionValidHook?.(task.sessionId)===false){this.finish(task,"cancelled",undefined,error("SESSION_ENDED","session expired before dispatch","waiting_host","not_dispatched"));return false;}
    if(task.target.binding.resourceEpoch!==this.resourceEpoch){this.finish(task,"failed",undefined,error("TARGET_CHANGED","stale resource epoch","waiting_host","not_dispatched"));return false;}
    if (this.validateCommitHook !== undefined) {
      let validation: true | TaskError;
      try {
        validation = this.validateCommitHook({ taskId, task: this.snapshot(task), prepared: task.prepared });
      } catch (caught) {
        validation = normalizeError(caught, "waiting_host", "not_dispatched");
      }
      if (validation !== true) {
        this.finish(task, "failed", undefined, normalizeError(validation, "waiting_host", "not_dispatched"));
        return false;
      }
    }
    const now = this.clock.monotonic();
    task.dispatchCommitted = true;
    task.phase = "dispatched";
    task.execution = "unknown";
    task.committedMono = now;
    task.dispatchedAt = this.clock.wall();
    task.executionDeadline = now + task.timeoutMs;
    task.hostDeadline = undefined;
    task.payload = undefined;
    task.prepared = undefined;
    this.scheduleMaintenance();
    return true;
  }

  sessionClosed(sessionId: string): TaskSnapshot[] {
    this.maintain();
    this.closedSessions.delete(sessionId);
    this.closedSessions.set(sessionId,this.clock.monotonic()+MAX_TERMINAL_MS+PREPARATION_BUDGET_MS);
    // The transport owns authoritative session validity. These bounded tombstones
    // cover close/submit races; cancelled task signals independently prevent dispatch.
    while(this.closedSessions.size>512)this.closedSessions.delete(this.closedSessions.keys().next().value!);
    const cancelled: TaskSnapshot[] = [];
    for (const taskId of [...this.queue]) {
      const task = this.tasks.get(taskId);
      if (task === undefined || task.sessionId !== sessionId) continue;
      this.finish(task, "cancelled", undefined, error("SESSION_ENDED", "session ended before dispatch", "queued", "not_dispatched"));
      cancelled.push(this.snapshot(task));
    }
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    if (active !== undefined && active.sessionId === sessionId && !active.dispatchCommitted && !isTerminal(active.state)) {
      this.finish(active, "cancelled", undefined, error("SESSION_ENDED", "session ended before dispatch", active.phase, "not_dispatched"));
      cancelled.push(this.snapshot(active));
    }
    return cancelled.sort((a,b)=>BigInt(a.sequence)<BigInt(b.sequence)?-1:1);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.maintenanceTimer !== undefined) {
      this.clock.clearTimer(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    if (active !== undefined && !isTerminal(active.state)) {
      active.abortController.abort();
      if (active.dispatchCommitted) {
        this.markUnknown(
          active,
          error("EXECUTION_UNKNOWN", "task state is unknown because the task center stopped", "dispatched", "unknown"),
        );
      } else {
        this.finish(active, "cancelled", undefined, error("SESSION_ENDED", "task center stopped before dispatch", active.phase, "not_dispatched"));
      }
    }
    for (const taskId of [...this.queue]) {
      const task = this.tasks.get(taskId);
      if (task !== undefined) {
        this.finish(task, "cancelled", undefined, error("SESSION_ENDED", "task center stopped before dispatch", "queued", "not_dispatched"));
      }
    }
    await Promise.resolve();
  }

  overview(): QueueOverview {
    this.maintain();
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    return {
      paused: active?.state === "unknown",
      blockingTaskId: active?.state === "unknown" ? active.taskId : null,
      active: active === undefined ? null : this.snapshot(active),
      queued: this.queue.flatMap((taskId) => {
        const task = this.tasks.get(taskId);
        return task === undefined ? [] : [this.summary(task)];
      }),
      recent: this.terminalOrder
        .slice(-RECENT_COUNT)
        .reverse()
        .flatMap((taskId) => {
          const task = this.tasks.get(taskId);
          return task === undefined ? [] : [this.summary(task)];
        }),
      retainedCount: this.terminalOrder.length,
      evictedCount: this.evictedCount,
    };
  }

  private kick(): void {
    void this.pump();
  }

  private async pump(): Promise<void> {
    this.maintain();
    if (this.stopped || this.pipelineBusy || this.activeId !== null) return;
    let task: InternalTask | undefined;
    while (this.queue.length > 0 && task === undefined) {
      const taskId = this.queue.shift();
      if (taskId !== undefined) {
        const candidate = this.tasks.get(taskId);
        if (candidate?.state === "queued") task = candidate;
      }
    }
    if (task === undefined) {
      this.scheduleMaintenance();
      return;
    }
    this.pipelineBusy = true;
    this.activeId = task.taskId;
    task.state = "running";
    task.phase = "preparing";
    task.startedMono = this.clock.monotonic();
    try {
      const context: PrepareContext = {
        taskId: task.taskId,
        task: this.snapshot(task),
        payload: clone(task.payload),
        signal: task.abortController.signal,
      };
      let outcome: PrepareOutcome;
      const preparationStarted = this.clock.monotonic();
      try {
        const prepared = await this.prepareHook(context);
        if (
          typeof prepared === "object" &&
          prepared !== null &&
          "ok" in prepared &&
          typeof (prepared as { ok?: unknown }).ok === "boolean"
        ) {
          outcome = prepared as PrepareOutcome;
        } else {
          outcome = { ok: true, value: prepared };
        }
      } catch (caught) {
        outcome = { ok: false, error: normalizeError(caught, "preparing", "not_dispatched") };
      }
      const preparationElapsed = this.clock.monotonic() - preparationStarted;
      this.maintain();
      if (task.state !== "running" || this.activeId !== task.taskId) return;
      if (preparationElapsed > PREPARATION_BUDGET_MS) {
        this.finish(
          task,
          "failed",
          undefined,
          error("PREPARATION_TIMEOUT", "task preparation exceeded 5000ms", "preparing", "not_dispatched"),
        );
        return;
      }
      if (!outcome.ok) {
        this.finish(task, "failed", undefined, normalizeError(outcome.error, "preparing", "not_dispatched"));
        return;
      }
      task.prepared = outcome.value;
      task.phase = "waiting_host";
      try { await this.yieldControl(); }
      catch (caught) { if(task.state==="running" && this.activeId===task.taskId) this.finish(task,"failed",undefined,normalizeError(caught,"waiting_host","not_dispatched")); return; }
      this.maintain();
      if (task.state !== "running" || this.activeId !== task.taskId) return;
      task.hostDeadline = this.clock.monotonic() + HOST_WAIT_MS;
      this.scheduleMaintenance();
      const dispatchContext: DispatchContext = {
        taskId: task.taskId,
        task: this.snapshot(task),
        prepared: task.prepared,
        signal: task.abortController.signal,
        dispatchCommitted: () => this.dispatchCommitted(task.taskId),
        settle: (evidence) => this.settle(task.taskId, evidence),
      };
      try {
        Promise.resolve(this.dispatchHook(dispatchContext)).catch((caught: unknown) => {
          this.handleDispatchFailure(task, caught);
        });
      } catch (caught) {
        this.handleDispatchFailure(task, caught);
      }
    } finally {
      this.pipelineBusy = false;
      this.kick();
    }
  }

  private handleDispatchFailure(task: InternalTask, caught: unknown): void {
    if (task.state !== "running") return;
    if (task.dispatchCommitted) {
      this.settle(task.taskId, {
        identity: task.target.binding,
        execution: "unknown",
        error: error("EXECUTION_UNKNOWN", "host dispatch failed after commit", "dispatched", "unknown"),
      });
      return;
    }
    this.finish(task, "failed", undefined, normalizeError(caught, "waiting_host", "not_dispatched"));
  }

  private finish(
    task: InternalTask,
    state: "succeeded" | "failed" | "cancelled",
    result?: TaskSnapshot["result"],
    taskError?: TaskError,
    terminalExecution: "not_dispatched" | "ended" = task.dispatchCommitted ? "ended" : "not_dispatched",
  ): void {
    if (isTerminal(task.state)) return;
    const previousPhase = task.phase;
    this.removeQueued(task.taskId);
    const now = this.clock.monotonic();
    task.state = state;
    task.phase = "settled";
    task.execution = terminalExecution;
    task.result = result;
    task.error = taskError;
    task.endedMono = now;
    task.endedAt = this.clock.wall();
    task.hostDeadline = undefined;
    task.executionDeadline = undefined;
    task.payload = undefined;
    task.prepared = undefined;
    task.abortController.abort();
    if (task.terminalFingerprint === undefined) {
      task.terminalFingerprint = JSON.stringify({ state, result, error: taskError, from: previousPhase });
    }
    if (this.activeId === task.taskId) this.activeId = null;
    task.retainedAt = now;
    const snapshot = this.snapshot(task);
    task.retainedBytes = bytes(snapshot);
    this.terminalBytes += task.retainedBytes;
    this.terminalOrder.push(task.taskId);
    this.evictTerminals();
    const waiters = this.settlementWaiters.get(task.taskId);
    if (waiters !== undefined) {
      for (const waiter of waiters) waiter();
      this.settlementWaiters.delete(task.taskId);
    }
    this.scheduleMaintenance();
    this.kick();
  }

  private markUnknown(task: InternalTask, taskError: TaskError, fingerprint?: string): void {
    if (task.state === "unknown" || isTerminal(task.state) || !task.dispatchCommitted) return;
    task.state = "unknown";
    task.phase = "dispatched";
    task.execution = "unknown";
    task.error = clone(taskError);
    task.result = undefined;
    task.executionDeadline = undefined;
    task.unknownFingerprint = fingerprint ?? JSON.stringify({ execution: "unknown", error: taskError });
    this.scheduleMaintenance();
  }

  private removeQueued(taskId: string): void {
    const index = this.queue.indexOf(taskId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private recoveryUnproven(task: InternalTask): TaskOperationResult {
    return {
      ok: false,
      error: error("RECOVERY_UNPROVEN", "no matching terminal evidence was found", "recovery", "unknown"),
      task: this.snapshot(task),
    };
  }

  private maintain(): void {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
    const now = this.clock.monotonic();
    for (const taskId of [...this.queue]) {
      const task = this.tasks.get(taskId);
      if (task?.state === "queued" && task.queueDeadline <= now) {
        this.finish(task, "failed", undefined, error("QUEUE_EXPIRED", "task expired before dispatch", "queued", "not_dispatched", true));
      }
    }
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    if (active?.state === "running") {
      if (!active.dispatchCommitted && active.hostDeadline !== undefined && active.hostDeadline <= now) {
        this.finish(active, "failed", undefined, error("HOST_UNAVAILABLE", "host dispatch did not commit within 2000ms", "waiting_host", "not_dispatched", true));
      } else if (active.dispatchCommitted && active.executionDeadline !== undefined && active.executionDeadline <= now) {
        this.markUnknown(active, error("EXECUTION_UNKNOWN", "execution deadline elapsed", "dispatched", "unknown"));
      }
    }
    for(const [sessionId,expires]of this.closedSessions)if(expires<=now)this.closedSessions.delete(sessionId);
    this.evictTerminals(now);
    } finally {
      this.maintaining = false;
    }
    this.scheduleMaintenance();
  }

  private evictTerminals(now = this.clock.monotonic()): void {
    for (;;) {
      const oldestId = this.terminalOrder[0];
      if (oldestId === undefined) return;
      const oldest = this.tasks.get(oldestId);
      if (oldest === undefined) {
        this.terminalOrder.shift();
        continue;
      }
      const expired = oldest.retainedAt !== undefined && oldest.retainedAt + MAX_TERMINAL_MS <= now;
      if (this.terminalOrder.length <= MAX_TERMINALS && this.terminalBytes <= MAX_TERMINAL_BYTES && !expired) return;
      this.terminalOrder.shift();
      this.terminalBytes -= oldest.retainedBytes ?? 0;
      this.tasks.delete(oldestId);
      this.evictedCount += 1;
    }
  }

  private scheduleMaintenance(): void {
    if (this.stopped) return;
    if (this.maintenanceTimer !== undefined) {
      this.clock.clearTimer(this.maintenanceTimer);
      this.maintenanceTimer = undefined;
    }
    let deadline = Number.POSITIVE_INFINITY;
    for (const taskId of this.queue) {
      const task = this.tasks.get(taskId);
      if (task !== undefined) deadline = Math.min(deadline, task.queueDeadline);
    }
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    if (active?.state === "running") {
      if (!active.dispatchCommitted && active.hostDeadline !== undefined) deadline = Math.min(deadline, active.hostDeadline);
      if (active.dispatchCommitted && active.executionDeadline !== undefined) deadline = Math.min(deadline, active.executionDeadline);
    }
    const oldestId = this.terminalOrder[0];
    const oldest = oldestId === undefined ? undefined : this.tasks.get(oldestId);
    if (oldest?.retainedAt !== undefined) deadline = Math.min(deadline, oldest.retainedAt + MAX_TERMINAL_MS);
    if (!Number.isFinite(deadline)) return;
    const delay = Math.max(0, deadline - this.clock.monotonic());
    this.maintenanceTimer = this.clock.setTimer(() => {
      this.maintenanceTimer = undefined;
      this.maintain();
      this.kick();
    }, delay);
  }

  private snapshot(task: InternalTask): TaskSnapshot {
    const now = this.clock.monotonic();
    const queueEnd = task.startedMono ?? task.endedMono ?? now;
    const executionEnd = task.endedMono ?? now;
    const snapshot: TaskSnapshot = {
      taskId: task.taskId,
      sequence: task.sequence,
      tool: task.tool,
      state: task.state,
      phase: task.phase,
      target: clone(task.target),
      createdAt: task.createdAt,
      queueMs: Math.max(0, Math.trunc(queueEnd - task.createdMono)),
      executionMs:
        task.committedMono === undefined ? 0 : Math.max(0, Math.trunc(executionEnd - task.committedMono)),
      execution: task.execution,
    };
    if (task.dispatchedAt !== undefined) snapshot.dispatchedAt = task.dispatchedAt;
    if (task.endedAt !== undefined) snapshot.endedAt = task.endedAt;
    if (task.result !== undefined) snapshot.result = clone(task.result);
    if (task.error !== undefined) snapshot.error = clone(task.error);
    return snapshot;
  }

  private summary(task: InternalTask): TaskSummary {
    const summary: TaskSummary = {
      taskId: task.taskId,
      sequence: task.sequence,
      tool: task.tool,
      state: task.state,
      phase: task.phase,
      target: clone(task.target),
      createdAt: task.createdAt,
    };
    if (task.error !== undefined) summary.errorCode = task.error.code;
    return summary;
  }
}

export const TASK_CENTER_LIMITS = Object.freeze({
  maxQueued: MAX_QUEUED,
  maxQueuedPerSession: MAX_QUEUED_PER_SESSION,
  maxQueueMs: MAX_QUEUE_MS,
  preparationBudgetMs: PREPARATION_BUDGET_MS,
  hostWaitMs: HOST_WAIT_MS,
  recoveryWaitMs: RECOVERY_WAIT_MS,
  defaultExecutionMs: DEFAULT_EXECUTION_MS,
  resourceExecutionMs: RESOURCE_EXECUTION_MS,
  maxResultBytes: MAX_RESULT_BYTES,
  maxTerminals: MAX_TERMINALS,
  maxTerminalBytes: MAX_TERMINAL_BYTES,
  maxTerminalMs: MAX_TERMINAL_MS,
  recentCount: RECENT_COUNT,
});

export function createTaskError(
  code: TaskError["code"],
  message: string,
  phase: TaskPhase,
  execution: TaskExecution,
  retryable = false,
  details?: JsonValue,
): TaskError {
  const created = error(code, message, phase, execution, retryable);
  if (details !== undefined) created.details = clone(details);
  return created;
}
