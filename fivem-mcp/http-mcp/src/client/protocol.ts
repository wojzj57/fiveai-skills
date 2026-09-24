import { byteLength, encodeClientValues } from "./browser-wire.ts";

const MAX_FRAME_BYTES = 384 * 1024;
const MAX_TERMINALS = 32;
const MAX_TERMINAL_BYTES = 8 * 1024 * 1024;
const MAX_REJECTION_BYTES = 8 * 1024;
const HELLO_INTERVAL_MS = 2_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const RESEND_INTERVAL_MS = 2_000;
const ACKED_RETENTION_MS = 5 * 60_000;

interface ClientBinding {
  resourceEpoch: string;
  clientId: number;
  connectionId: string;
  clientEpoch: string;
}

type TerminalPayload =
  | { execution: "ended"; result: { kind: "values"; values: unknown[] } }
  | { execution: "ended" | "not_dispatched"; error: Record<string, unknown> };

interface TerminalRecord {
  taskId: string;
  planHash: string;
  payload: TerminalPayload;
  raw: string;
  bytes: number;
  lastSentAt: number;
  ackedAt?: number;
}

interface ExecutePayload {
  kind: "js";
  code: string;
  args: unknown;
  timeoutMs: number;
  planHash: string;
}

export interface ClientProtocolOptions {
  resourceName: string;
  clientEpoch: string;
  send: (eventName: string, raw: string) => void;
  sendLocal: (eventName: string, raw: string) => void;
  executeJs: (code: string, args: unknown, timeoutMs: number) => unknown[] | Promise<unknown[]>;
  clock?: () => number;
  serverSource?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isBinding(value: unknown): value is ClientBinding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["resourceEpoch", "clientId", "connectionId", "clientEpoch"]) &&
    isUuid(value.resourceEpoch) &&
    Number.isInteger(value.clientId) &&
    Number(value.clientId) >= 1 &&
    Number(value.clientId) <= 2_147_483_647 &&
    isUuid(value.connectionId) &&
    isUuid(value.clientEpoch)
  );
}

function sameBinding(left: ClientBinding, right: ClientBinding): boolean {
  return (
    left.resourceEpoch === right.resourceEpoch &&
    left.clientId === right.clientId &&
    left.connectionId === right.connectionId &&
    left.clientEpoch === right.clientEpoch
  );
}

function sequenceOf(taskId: string, resourceEpoch: string): bigint | null {
  const prefix = `${resourceEpoch}:`;
  if (!taskId.startsWith(prefix)) return null;
  const value = taskId.slice(prefix.length);
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function errorPayload(code: string, message: string, execution: "ended" | "not_dispatched"): TerminalPayload {
  return {
    execution,
    error: {
      code,
      message: message.slice(0, 4096) || code,
      phase: execution === "ended" ? "dispatched" : "preparing",
      retryable: false,
      execution,
    },
  };
}

function executionCode(error: unknown): string {
  const message = String(error);
  for (const code of ["DEPENDENCY_MISSING", "DEPENDENCY_VERSION_UNSUPPORTED", "METHOD_UNSUPPORTED"]) {
    if (message.includes(code)) return code;
  }
  if (message.includes("RESULT_TOO_LARGE")) return "RESULT_TOO_LARGE";
  if (message.includes("RESULT_UNSUPPORTED")) return "RESULT_UNSUPPORTED";
  return "EXECUTION_FAILED";
}

export class ClientProtocol {
  private readonly options: ClientProtocolOptions;
  private readonly clock: () => number;
  private readonly serverSource: number;
  private binding: ClientBinding | null = null;
  private started = false;
  private stopped = false;
  private lua = false;
  private lastHelloAt = Number.NEGATIVE_INFINITY;
  private lastHeartbeatAt = 0;
  private highWater = 0n;
  private readonly active = new Map<string, string>();
  private readonly unacked = new Map<string, TerminalRecord>();
  private readonly acked = new Map<string, TerminalRecord>();
  private rejection: TerminalRecord | null = null;

  constructor(options: ClientProtocolOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => performance.now());
    this.serverSource = options.serverSource ?? 65_535;
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.sendHello();
  }

  receive(source: number, type: string, raw: string): boolean {
    if (this.stopped || source !== this.serverSource || typeof raw !== "string" || byteLength(raw) > MAX_FRAME_BYTES) {
      return false;
    }
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return false;
      message = parsed;
    } catch {
      return false;
    }
    if (message.v !== 1 || message.type !== type) return false;
    if (type === "bind") return this.bind(message, raw);
    if (!this.binding || !isBinding(message.binding) || !sameBinding(this.binding, message.binding)) return false;
    if (type === "execute") return this.execute(message);
    if (type === "terminalAck") return this.terminalAck(message);
    if (type === "probe") return this.probe(message);
    return false;
  }

  luaReady(raw: string): boolean {
    if (!this.binding || typeof raw !== "string" || byteLength(raw) > MAX_FRAME_BYTES) return false;
    try {
      const message: unknown = JSON.parse(raw);
      if (!isRecord(message) || !hasOnlyKeys(message, ["binding"]) || !isBinding(message.binding) || !sameBinding(this.binding, message.binding)) return false;
      this.lua = true;
      return true;
    } catch {
      return false;
    }
  }

  tick(): void {
    if (!this.started || this.stopped) return;
    const now = this.clock();
    if (now - this.lastHelloAt >= HELLO_INTERVAL_MS) this.sendHello();
    if (!this.binding) return;
    if (now - this.lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      this.sendFrame("heartbeat", { v: 1, type: "heartbeat", binding: this.binding, payload: { lua: this.lua, js: true } });
      this.lastHeartbeatAt = now;
    }
    for (const record of this.unacked.values()) {
      if (now - record.lastSentAt >= RESEND_INTERVAL_MS) this.sendTerminal(record);
    }
    if (this.rejection && now - this.rejection.lastSentAt >= RESEND_INTERVAL_MS) this.sendTerminal(this.rejection);
    for (const [taskId, record] of this.acked) {
      if ((record.ackedAt ?? now) + ACKED_RETENTION_MS < now) this.acked.delete(taskId);
    }
    this.trimAcked();
  }

  cacheSnapshot(): { unacked: number; acked: number; bytes: number; rejectionTaskId: string | null; highWater: string } {
    return {
      unacked: this.unacked.size,
      acked: this.acked.size,
      bytes: this.totalBytes(this.unacked),
      rejectionTaskId: this.rejection?.taskId ?? null,
      highWater: String(this.highWater),
    };
  }

  stop(): void {
    this.stopped = true;
    this.binding = null;
    this.active.clear();
    this.unacked.clear();
    this.acked.clear();
    this.rejection = null;
  }

  private bind(message: Record<string, unknown>, raw: string): boolean {
    if (!hasOnlyKeys(message, ["v", "type", "binding", "payload"])) return false;
    if (!isBinding(message.binding) || message.binding.clientEpoch !== this.options.clientEpoch) return false;
    const payload = message.payload;
    if (!isRecord(payload) || !hasOnlyKeys(payload, ["logMarker"]) || typeof payload.logMarker !== "string" || !/^[a-f0-9]{32}$/.test(payload.logMarker)) return false;
    const repeated = this.binding !== null && sameBinding(this.binding, message.binding);
    if (this.binding && !repeated) this.resetExecutionState();
    this.binding = { ...message.binding };
    if (!repeated) {
      this.lua = false;
      this.lastHeartbeatAt = this.clock();
    }
    this.options.sendLocal(this.localEvent("clientBind"), raw);
    return true;
  }

  private execute(message: Record<string, unknown>): boolean {
    if (!hasOnlyKeys(message, ["v", "type", "binding", "taskId", "payload"])) return false;
    if (!this.binding || typeof message.taskId !== "string" || !isRecord(message.payload)) return false;
    const payload = message.payload;
    if (
      !hasOnlyKeys(payload, ["kind", "code", "args", "timeoutMs", "planHash"]) ||
      payload.kind !== "js" ||
      typeof payload.code !== "string" ||
      !("args" in payload) ||
      !Number.isInteger(payload.timeoutMs) ||
      Number(payload.timeoutMs) < 100 ||
      Number(payload.timeoutMs) > 60_000 ||
      typeof payload.planHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(payload.planHash)
    ) {
      return false;
    }
    const taskId = message.taskId;
    const planHash = payload.planHash;
    const sequence = sequenceOf(taskId, this.binding.resourceEpoch);
    if (sequence === null) return false;
    const cached = this.unacked.get(taskId) ?? this.acked.get(taskId) ?? (this.rejection?.taskId === taskId ? this.rejection : undefined);
    if (cached) {
      if (cached.planHash === planHash) this.sendTerminal(cached);
      else this.refuse(taskId, planHash, sequence, "EXECUTION_FAILED", "Conflicting plan hash");
      return true;
    }
    const activeHash = this.active.get(taskId);
    if (activeHash) {
      if (activeHash !== planHash) this.refuse(taskId, planHash, sequence, "EXECUTION_FAILED", "Conflicting plan hash");
      return true;
    }
    if (this.rejection) {
      if (this.rejection.taskId === taskId) this.sendTerminal(this.rejection);
      return true;
    }
    if (sequence <= this.highWater) {
      this.refuse(taskId, planHash, sequence, "EXECUTION_FAILED", "Execute sequence is not newer than the accepted high-water mark");
      return true;
    }
    if (this.unacked.size + this.active.size >= MAX_TERMINALS || this.totalBytes(this.unacked) + (this.active.size + 1) * 393216 > MAX_TERMINAL_BYTES) {
      this.refuse(taskId, planHash, sequence, "EXECUTOR_FULL", "Terminal cache is full");
      return true;
    }
    this.highWater = sequence;
    const acceptedBinding=this.binding;
    this.active.set(taskId, planHash);
    const execution = payload as unknown as ExecutePayload;
    void Promise.resolve()
      .then(() => this.options.executeJs(execution.code, execution.args, execution.timeoutMs))
      .then(
        (values) => {
          if(!this.binding||!sameBinding(this.binding,acceptedBinding))return;
          try {
            this.finish(taskId, planHash, { execution: "ended", result: encodeClientValues(values) });
          } catch (error) {
            this.finish(taskId, planHash, errorPayload(executionCode(error), String(error), "ended"));
          }
        },
        (error) => {if(this.binding&&sameBinding(this.binding,acceptedBinding))this.finish(taskId, planHash, errorPayload(executionCode(error), String(error), "ended"));},
      );
    return true;
  }

  private terminalAck(message: Record<string, unknown>): boolean {
    if (!hasOnlyKeys(message, ["v", "type", "binding", "taskId", "payload"])) return false;
    if (typeof message.taskId !== "string" || !isRecord(message.payload) || Object.keys(message.payload).length !== 0) return false;
    if (this.rejection?.taskId === message.taskId) {
      this.rejection = null;
      return true;
    }
    const record = this.unacked.get(message.taskId);
    if (!record) return this.acked.has(message.taskId);
    this.unacked.delete(message.taskId);
    record.ackedAt = this.clock();
    this.acked.set(message.taskId, record);
    this.trimAcked();
    return true;
  }

  private probe(message: Record<string, unknown>): boolean {
    if (!hasOnlyKeys(message, ["v", "type", "binding", "taskId", "payload"])) return false;
    if (!this.binding || typeof message.taskId !== "string" || !isRecord(message.payload) || Object.keys(message.payload).length !== 0) return false;
    const record = this.unacked.get(message.taskId) ?? this.acked.get(message.taskId) ?? (this.rejection?.taskId === message.taskId ? this.rejection : undefined);
    const payload = record ? { known: true, terminal: record.payload } : { known: false };
    this.sendFrame("probeResult", { v: 1, type: "probeResult", binding: this.binding, taskId: message.taskId, payload });
    return true;
  }

  private finish(taskId: string, planHash: string, payload: TerminalPayload): void {
    this.active.delete(taskId);
    if (!this.binding || this.stopped) return;
    const record = this.makeRecord(taskId, planHash, payload);
    if (this.unacked.size >= MAX_TERMINALS || this.totalBytes(this.unacked) + record.bytes > MAX_TERMINAL_BYTES) {
      this.rejection=this.makeRecord(taskId,planHash,errorPayload("EXECUTOR_FULL","Terminal cache reservation exceeded","ended"));
      this.sendTerminal(this.rejection);
      return;
    }
    this.unacked.set(taskId, record);
    this.sendTerminal(record);
  }

  private refuse(taskId: string, planHash: string, sequence: bigint, code: string, message: string): void {
    if (!this.binding) return;
    if (sequence > this.highWater) this.highWater = sequence;
    if (this.rejection) {
      this.sendTerminal(this.rejection);
      return;
    }
    const record = this.makeRecord(taskId, planHash, errorPayload(code, message, "not_dispatched"));
    if (record.bytes > MAX_REJECTION_BYTES) throw new Error("bounded rejection exceeded 8KiB");
    this.rejection = record;
    this.sendTerminal(record);
  }

  private makeRecord(taskId: string, planHash: string, payload: TerminalPayload): TerminalRecord {
    if (!this.binding) throw new Error("binding unavailable");
    const raw = JSON.stringify({ v: 1, type: "terminal", binding: this.binding, taskId, payload });
    return { taskId, planHash, payload, raw, bytes: byteLength(raw), lastSentAt: Number.NEGATIVE_INFINITY };
  }

  private sendTerminal(record: TerminalRecord): void {
    this.options.send(this.event("terminal"), record.raw);
    record.lastSentAt = this.clock();
  }

  private sendHello(): void {
    this.sendFrame("hello", { v: 1, type: "hello", payload: { clientEpoch: this.options.clientEpoch, lua: true, js: true } });
    this.lastHelloAt = this.clock();
  }

  private sendFrame(type: string, frame: object): void {
    const raw = JSON.stringify(frame);
    if (byteLength(raw) > MAX_FRAME_BYTES) throw new Error("INPUT_TOO_LARGE");
    this.options.send(this.event(type), raw);
  }

  private event(type: string): string {
    return `${this.options.resourceName}:mcp:v1:${type}`;
  }

  private localEvent(type: string): string {
    return `${this.options.resourceName}:mcp:v1:local:${type}`;
  }

  private totalBytes(records: Map<string, TerminalRecord>): number {
    let total = 0;
    for (const record of records.values()) total += record.bytes;
    return total;
  }

  private trimAcked(): void {
    while (this.acked.size > MAX_TERMINALS || this.totalBytes(this.acked) > MAX_TERMINAL_BYTES) {
      const oldest = this.acked.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.acked.delete(oldest);
    }
  }

  private resetExecutionState(): void {
    this.highWater = 0n;
    this.active.clear();
    this.unacked.clear();
    this.acked.clear();
    this.rejection = null;
  }
}
