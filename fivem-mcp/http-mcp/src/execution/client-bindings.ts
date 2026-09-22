import { randomBytes, randomUUID } from "node:crypto";

import { validate } from "../shared/schema.ts";
import type { ClientBinding, TaskError, TaskResult } from "../tasks/types.ts";

const MAX_FRAME_BYTES = 384 * 1024;
const HEARTBEAT_TIMEOUT_MS = 15_000;
const CONTROL_RATE = 20;
const TERMINAL_RATE = 2;

export type ClientExecutePayload =
  | {
      kind: "lua" | "js";
      code: string;
      args: unknown;
      timeoutMs: number;
      planHash: string;
    }
  | {
      kind: "adapter";
      adapter: "esx" | "qbcore" | "ox_lib" | "ox_target";
      method: string;
      args: unknown[];
      timeoutMs: number;
      planHash: string;
    };

export type ClientTerminalPayload =
  | { execution: "ended"; result: TaskResult }
  | { execution: "ended" | "not_dispatched"; error: TaskError };

export interface ClientTerminalMessage {
  v: 1;
  type: "terminal";
  binding: ClientBinding;
  taskId: string;
  payload: ClientTerminalPayload;
}

export interface ClientProbeResultMessage {
  v: 1;
  type: "probeResult";
  binding: ClientBinding;
  taskId: string;
  payload: { known: false } | { known: true; terminal: ClientTerminalPayload };
}

export interface ClientSnapshot {
  clientId: number;
  connectionId: string;
  clientEpoch: string;
  ready: boolean;
  lua: boolean;
  js: boolean;
  lastHeartbeat: string;
}

export type BindingLostReason = "epoch_replaced" | "heartbeat_timeout" | "player_dropped" | "stopped";

interface RateWindow {
  startedAt: number;
  control: number;
  terminal: number;
}

interface BindingState {
  binding: ClientBinding;
  logMarker: string;
  advertisedLua: boolean;
  advertisedJs: boolean;
  lua: boolean;
  js: boolean;
  ready: boolean;
  lastHeartbeatAt: number;
  lastHeartbeat: string;
  dispatchedHighWater: bigint;
  settledHighWater: bigint;
  pendingTasks: Set<string>;
}

interface WireClientBinding {
  resourceEpoch: string;
  clientId: number;
  connectionId: string;
  clientEpoch: string;
}

export interface ClientBindingManagerOptions {
  resourceName: string;
  resourceEpoch: string;
  send: (clientId: number, eventName: string, raw: string) => void;
  onTerminal: (message: ClientTerminalMessage | ClientProbeResultMessage) => boolean;
  onBindingLost?: (binding: ClientBinding, reason: BindingLostReason) => void;
  onBound?: (binding: ClientBinding, logMarker: string) => void;
  clock?: () => number;
  wall?: () => string;
  uuid?: () => string;
  logMarker?: () => string;
}

function wireBinding(binding: ClientBinding): WireClientBinding {
  const { resourceEpoch, clientId, connectionId, clientEpoch } = binding;
  return { resourceEpoch, clientId, connectionId, clientEpoch };
}

function sameBinding(left: ClientBinding, right: WireClientBinding): boolean {
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

function encodeFrame(frame: object): string {
  const raw = JSON.stringify(frame);
  if (Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) throw new Error("INPUT_TOO_LARGE");
  return raw;
}

export function encodeClientExecute(
  binding: ClientBinding,
  taskId: string,
  payload: ClientExecutePayload,
): string {
  const frame = { v: 1, type: "execute", binding: wireBinding(binding), taskId, payload };
  const raw = encodeFrame(frame);
  if (!validate("InternalMessage", frame)) throw new Error("invalid client execute frame");
  return raw;
}

export class ClientBindingManager {
  private readonly options: ClientBindingManagerOptions;
  private readonly states = new Map<number, BindingState>();
  private readonly rates = new Map<number, RateWindow>();
  private readonly clock: () => number;
  private readonly wall: () => string;
  private readonly uuid: () => string;
  private readonly marker: () => string;
  private stopped = false;

  constructor(options: ClientBindingManagerOptions) {
    this.options = options;
    this.clock = options.clock ?? (() => performance.now());
    this.wall = options.wall ?? (() => new Date().toISOString());
    this.uuid = options.uuid ?? randomUUID;
    this.marker = options.logMarker ?? (() => randomBytes(16).toString("hex"));
  }

  receive(source: number, type: string, raw: string): boolean {
    if (this.stopped || !Number.isInteger(source) || source < 1 || source > 2_147_483_647) return false;
    this.sweep();
    if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_FRAME_BYTES) return false;
    if (!this.takeRate(source, type === "terminal" || type === "probeResult")) return false;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return false;
    }
    if (!validate("InternalMessage", value)) return false;
    const message = value as Record<string, unknown>;
    if (message.type !== type) return false;
    if (type === "hello") return this.hello(source, message);

    const state = this.states.get(source);
    const binding = message.binding as WireClientBinding | undefined;
    if (!state || !binding || !sameBinding(state.binding, binding)) return false;

    if (type === "heartbeat") {
      const payload = message.payload as { lua: boolean; js: boolean };
      state.lua = payload.lua && state.advertisedLua;
      state.js = payload.js && state.advertisedJs;
      state.ready = state.lua && state.js;
      state.lastHeartbeatAt = this.clock();
      state.lastHeartbeat = this.wall();
      return true;
    }
    if (type !== "terminal" && type !== "probeResult") return false;
    const taskId = message.taskId;
    if (typeof taskId !== "string") return false;
    const sequence = sequenceOf(taskId, this.options.resourceEpoch);
    if (sequence === null || sequence > state.dispatchedHighWater) return false;

    if (type === "terminal" && sequence <= state.settledHighWater && !state.pendingTasks.has(taskId)) {
      return this.ack(state.binding, taskId);
    }
    if (!state.pendingTasks.has(taskId)) return false;
    let accepted = false;
    try {
      accepted = this.options.onTerminal({
        ...message,
        binding: { ...state.binding },
      } as unknown as ClientTerminalMessage | ClientProbeResultMessage);
    } catch {
      return false;
    }
    if (!accepted) return false;
    const probe = message as unknown as ClientProbeResultMessage;
    if (type === "probeResult" && probe.payload.known === false) return true;
    state.pendingTasks.delete(taskId);
    if (sequence > state.settledHighWater) state.settledHighWater = sequence;
    return this.ack(state.binding, taskId);
  }

  snapshots(): ClientSnapshot[] {
    this.sweep();
    return [...this.states.values()]
      .map((state) => ({
        clientId: state.binding.clientId,
        connectionId: state.binding.connectionId,
        clientEpoch: state.binding.clientEpoch,
        ready: state.ready,
        lua: state.lua,
        js: state.js,
        lastHeartbeat: state.lastHeartbeat,
      }))
      .sort((left, right) => left.clientId - right.clientId);
  }

  resolveTarget(clientId: number): ClientBinding | null {
    this.sweep();
    const state = this.states.get(clientId);
    return state?.ready ? { ...state.binding } : null;
  }

  sendExecute(binding: ClientBinding, taskId: string, payload: ClientExecutePayload): boolean {
    const state = this.current(binding, true);
    if (!state) return false;
    const sequence = sequenceOf(taskId, this.options.resourceEpoch);
    if (sequence === null || sequence <= state.dispatchedHighWater) return false;
    const raw = encodeClientExecute(binding, taskId, payload);
    this.options.send(binding.clientId, this.event("execute"), raw);
    state.dispatchedHighWater = sequence;
    state.pendingTasks.add(taskId);
    return true;
  }

  probe(binding: ClientBinding, taskId: string): boolean {
    const state = this.current(binding, false);
    if (!state || !state.pendingTasks.has(taskId)) return false;
    return this.send(state, "probe", taskId, {});
  }

  ack(binding: ClientBinding, taskId: string): boolean {
    const state = this.current(binding, false);
    if (!state) return false;
    const sequence = sequenceOf(taskId, this.options.resourceEpoch);
    if (sequence === null || sequence > state.dispatchedHighWater) return false;
    return this.send(state, "terminalAck", taskId, {});
  }

  drop(clientId: number): void {
    this.invalidate(clientId, "player_dropped");
  }

  sweep(): void {
    if (this.stopped) return;
    const now = this.clock();
    for (const [clientId, state] of this.states) {
      if (now - state.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
        this.invalidate(clientId, "heartbeat_timeout");
      }
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const clientId of [...this.states.keys()]) this.invalidate(clientId, "stopped");
    this.rates.clear();
  }

  private hello(source: number, message: Record<string, unknown>): boolean {
    const payload = message.payload as { clientEpoch: string; lua: boolean; js: boolean };
    let state = this.states.get(source);
    if (state && state.binding.clientEpoch !== payload.clientEpoch) {
      this.invalidate(source, "epoch_replaced");
      state = undefined;
    }
    if (!state) {
      const binding: ClientBinding = {
        resourceEpoch: this.options.resourceEpoch,
        side: "client",
        clientId: source,
        connectionId: this.uuid(),
        clientEpoch: payload.clientEpoch,
      };
      state = {
        binding,
        logMarker: this.marker(),
        advertisedLua: payload.lua,
        advertisedJs: payload.js,
        lua: false,
        js: false,
        ready: false,
        lastHeartbeatAt: this.clock(),
        lastHeartbeat: this.wall(),
        dispatchedHighWater: 0n,
        settledHighWater: 0n,
        pendingTasks: new Set(),
      };
      this.states.set(source, state);
      this.options.onBound?.({ ...binding }, state.logMarker);
    }
    const frame = { v: 1, type: "bind", binding: wireBinding(state.binding), payload: { logMarker: state.logMarker } };
    this.options.send(source, this.event("bind"), encodeFrame(frame));
    return true;
  }

  private send(state: BindingState, type: "probe" | "terminalAck", taskId: string, payload: object): boolean {
    const raw = encodeFrame({ v: 1, type, binding: wireBinding(state.binding), taskId, payload });
    this.options.send(state.binding.clientId, this.event(type), raw);
    return true;
  }

  private current(binding: ClientBinding, requireReady: boolean): BindingState | null {
    this.sweep();
    const state = this.states.get(binding.clientId);
    if (!state || !sameBinding(state.binding, binding) || (requireReady && !state.ready)) return null;
    return state;
  }

  private event(type: string): string {
    return `${this.options.resourceName}:mcp:v1:${type}`;
  }

  private invalidate(clientId: number, reason: BindingLostReason): void {
    const state = this.states.get(clientId);
    if (!state) return;
    this.states.delete(clientId);
    this.options.onBindingLost?.({ ...state.binding }, reason);
  }

  private takeRate(source: number, terminal: boolean): boolean {
    const now = this.clock();
    let window = this.rates.get(source);
    if (!window || now - window.startedAt >= 1_000) {
      window = { startedAt: now, control: 0, terminal: 0 };
      this.rates.set(source, window);
    }
    if (terminal) {
      if (window.terminal >= TERMINAL_RATE) return false;
      window.terminal += 1;
      return true;
    }
    if (window.control >= CONTROL_RATE) return false;
    window.control += 1;
    return true;
  }
}
