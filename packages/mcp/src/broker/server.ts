/**
 * The shared broker (RFC §4/§5). One OS user runs one broker; it holds the
 * lifetime named pipe and the loopback WebSocket listener, authenticates
 * entry and bridge connections by role token, and serves the control
 * channel. This first runtime slice serves the real `status` tool from
 * live broker state; the FIFO/task pipeline, adapters, and log collection
 * arrive in later slices and are NOT silently faked here.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import { LIMITS } from "../protocol/limits.ts";
import { parseMessage, type AnyTypedMessage, type MessageEnvelope } from "../protocol/envelope.ts";
import type { Hello } from "../protocol/messages.ts";
import { RuntimeFileSchema, type DiscoveryInfo } from "../protocol/runtime.ts";
import { CLOSE_CODES, CLOSE_REASONS } from "../protocol/close-codes.ts";
import { StatusInputSchema } from "../tools/schemas.ts";
import { REGISTERED_TOOLS } from "../tools/registry.ts";
import {
  SCREENSHOT_ENABLED,
  SCREENSHOT_IMPLEMENTED,
} from "../contracts/screenshot.disabled.ts";
import { tokenMatches, type LoadedRuntimeConfig } from "../cli/config.ts";
import { BUILD_ID } from "../build.ts";
import {
  serveLifetimeDiscovery,
  brokerPipeNames,
  type BrokerPipeNames,
} from "./pipes.ts";
import { RecoveryStore, type RecoveryLoad } from "./recovery-store.ts";
import { assertStatePaths } from "../shared/paths.ts";
import { verifyProcessIdentity, type ProcessIdentityCheck } from "./process-identity.ts";

/** Startup failures the entry maps to RFC §4.2 exit conditions. */
export class BrokerStartupError extends Error {
  readonly condition: "PORT_IN_USE" | "INSTANCE_CONFLICT";

  constructor(condition: "PORT_IN_USE" | "INSTANCE_CONFLICT", message: string) {
    super(message);
    this.name = "BrokerStartupError";
    this.condition = condition;
  }
}

/** No hello within this window closes the connection as unauthenticated. */
const HANDSHAKE_TIMEOUT_MS = 5_000;

interface Session {
  sessionId: string;
  role: "entry" | "bridge";
  socket: WebSocket;
  hello: Hello | null;
  connectedAt: string;
  lastPongAt: number;
  outstandingPingNonce: string | null;
  handshakeTimer: NodeJS.Timeout;
  heartbeatTimer: NodeJS.Timeout;
  registered: boolean;
  identityCheck: ProcessIdentityCheck;
}

function envelopeOf(
  type: MessageEnvelope["type"],
  payload: unknown,
  identity: { brokerInstanceId: string; sessionId: string },
  id: string = randomUUID(),
): unknown {
  return {
    v: 1,
    id,
    type,
    brokerInstanceId: identity.brokerInstanceId,
    sessionId: identity.sessionId,
    payload,
  };
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    try {
      socket.terminate();
    } catch {
      // Already fully closed.
    }
  }
}

export class Broker {
  readonly brokerInstanceId = randomUUID();
  readonly startedAt = new Date();
  private readonly sessions = new Map<string, Session>();
  private readonly connections = new Set<Session>();
  private bridgeSession: Session | null = null;
  private recovery: RecoveryLoad;
  private recoveryWriteError: string | null = null;
  private shuttingDown = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private app: FastifyInstance | null = null;
  private lifetimePipe: net.Server | null = null;
  private pipeNames: BrokerPipeNames | null = null;
  private store: RecoveryStore | null = null;
  private exitResolve: (() => void) | null = null;
  private readonly shutdownPromise: Promise<void>;

  private readonly loaded: LoadedRuntimeConfig;

  constructor(loaded: LoadedRuntimeConfig) {
    this.loaded = loaded;
    this.recovery = { ok: false, code: "STATE_STORE_ERROR", message: "not loaded" };
    this.shutdownPromise = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
  }

  /** Resolves when the broker has shut itself down (grace expiry or signal). */
  waitUntilShutdown(): Promise<void> {
    return this.shutdownPromise;
  }

  async start(): Promise<void> {
    const { config, configDigest } = this.loaded;
    this.pipeNames = await brokerPipeNames();

    // Lifetime pipe first: whoever holds it owns scheduling for this user
    // (RFC §4.2). A failed bind means another broker is alive.
    try {
      this.lifetimePipe = await serveLifetimeDiscovery(this.pipeNames.lifetime, {
        port: config.broker.port,
        internalProtocol: 1,
        configDigest,
        brokerInstanceId: this.brokerInstanceId,
      });
    } catch (error) {
      throw new BrokerStartupError(
        "INSTANCE_CONFLICT",
        `the lifetime pipe is already held by another broker: ${(error as Error).message}`,
      );
    }

    const app = fastify({ logger: false });
    this.app = app;
    try {
      await app.register(websocket, {
        options: {
          maxPayload: LIMITS.message.frameMaxBytes,
          perMessageDeflate: false,
        },
      });
      for (const role of ["entry", "bridge"] as const) {
        app.addHook("onRequest", async (request, reply) => {
          if (request.url.split("?")[0] !== `/internal/v1/${role}`) return;
          const rejection = this.closeCodeFor(request.headers, role);
          if (rejection || !["127.0.0.1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) {
            return reply.code(401).send({ error: "UNAUTHORIZED" });
          }
          if (this.shuttingDown) return reply.code(503).send({ error: "SHUTTING_DOWN" });
        });
      }
      app.get("/internal/v1/entry", { websocket: true }, (socket, request) => {
        void this.onConnection(socket, request.headers, "entry").catch(() => {
          closeSocket(socket, CLOSE_CODES.PROTOCOL_ERROR, CLOSE_REASONS.PROTOCOL_ERROR);
        });
      });
      app.get("/internal/v1/bridge", { websocket: true }, (socket, request) => {
        void this.onConnection(socket, request.headers, "bridge").catch(() => {
          closeSocket(socket, CLOSE_CODES.PROTOCOL_ERROR, CLOSE_REASONS.PROTOCOL_ERROR);
        });
      });

      try {
        await app.listen({ host: config.broker.host, port: config.broker.port });
      } catch (error) {
        throw new BrokerStartupError(
          "PORT_IN_USE",
          `cannot listen on ${config.broker.host}:${config.broker.port}: ${(error as Error).message}`,
        );
      }
      this.app = app;

      // stateDir: runtime.json, owner lock, recovery.json (RFC §4.1).
      assertStatePaths(config.stateDir);
      mkdirSync(config.stateDir, { recursive: true });
      assertStatePaths(config.stateDir);
      this.store = new RecoveryStore(config.stateDir);
      this.recovery = this.store.load();
      if (this.recovery.ok && this.recovery.created) {
        // Materialize the fresh record so corruption is detectable later and
        // the write path is proven before any dispatch could depend on it.
        try {
          this.store.save(this.recovery.file);
        } catch (error) {
          this.recoveryWriteError = (error as Error).message;
        }
      }
      writeFileSync(
        join(config.stateDir, "runtime.json"),
        `${JSON.stringify(
          RuntimeFileSchema.parse({
            version: 1,
            pid: process.pid,
            brokerInstanceId: this.brokerInstanceId,
            internalProtocol: 1,
            configDigest,
            startedAt: this.startedAt.toISOString(),
          }),
        )}\n`,
      );
      writeFileSync(
        join(config.stateDir, "owner.lock"),
        `${JSON.stringify({
          pid: process.pid,
          brokerInstanceId: this.brokerInstanceId,
          startedAt: this.startedAt.toISOString(),
        })}\n`,
      );
      if (this.recovery.ok && this.recovery.file.pending !== null) {
        process.stderr.write(
          `fiveai-mcp broker: recovery.json carries an unresolved dispatch intent (task ${this.recovery.file.pending.taskId}); dispatch stays blocked until it is reconciled\n`,
        );
      }

      this.updateGrace();
      process.stderr.write(
        `fiveai-mcp broker ${this.brokerInstanceId} listening on ${config.broker.host}:${config.broker.port}\n`,
      );
    } catch (error) {
      await this.shutdown("startup failed");
      throw error;
    }
  }

  private async releaseLifetimePipe(): Promise<void> {
    const pipe = this.lifetimePipe;
    this.lifetimePipe = null;
    if (pipe === null) return;
    await new Promise<void>((resolve) => {
      pipe.close(() => resolve());
    });
  }

  private closeCodeFor(headers: Record<string, string | string[] | undefined>, role: "entry" | "bridge"): void | { code: number; reason: string } {
    const origin = headers.origin;
    if (origin !== undefined) {
      return { code: CLOSE_CODES.UNAUTHORIZED, reason: `${CLOSE_REASONS.UNAUTHORIZED}: browser origins are rejected` };
    }
    const host = headers.host;
    const expectedHost = `${this.loaded.config.broker.host}:${this.loaded.config.broker.port}`;
    if (host !== expectedHost) {
      return { code: CLOSE_CODES.UNAUTHORIZED, reason: `${CLOSE_REASONS.UNAUTHORIZED}: bad host` };
    }
    const authorization = headers.authorization;
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer ")) {
      return { code: CLOSE_CODES.UNAUTHORIZED, reason: `${CLOSE_REASONS.UNAUTHORIZED}: missing bearer token` };
    }
    const presented = authorization.slice("Bearer ".length);
    const ownToken = role === "entry" ? this.loaded.entryToken : this.loaded.bridgeToken;
    const otherToken = role === "entry" ? this.loaded.bridgeToken : this.loaded.entryToken;
    if (!tokenMatches(presented, ownToken) || tokenMatches(presented, otherToken)) {
      return { code: CLOSE_CODES.UNAUTHORIZED, reason: `${CLOSE_REASONS.UNAUTHORIZED}: token does not grant this role` };
    }
    return undefined;
  }

  private async onConnection(
    socket: WebSocket,
    headers: Record<string, string | string[] | undefined>,
    role: "entry" | "bridge",
  ): Promise<void> {
    if (this.shuttingDown) {
      closeSocket(socket, CLOSE_CODES.SHUTTING_DOWN, CLOSE_REASONS.SHUTTING_DOWN);
      return;
    }
    const rejection = this.closeCodeFor(headers, role);
    if (rejection !== undefined) {
      closeSocket(socket, rejection.code, rejection.reason);
      return;
    }
    const session: Session = {
      sessionId: randomUUID(),
      role,
      socket,
      hello: null,
      connectedAt: new Date().toISOString(),
      lastPongAt: Date.now(),
      outstandingPingNonce: null,
      handshakeTimer: setTimeout(() => {
        if (session.hello === null) {
          closeSocket(socket, CLOSE_CODES.HANDSHAKE_TIMEOUT, CLOSE_REASONS.HANDSHAKE_TIMEOUT);
        }
      }, HANDSHAKE_TIMEOUT_MS),
      heartbeatTimer: setInterval(() => this.heartbeatTick(session), LIMITS.heartbeat.intervalMs),
      registered: false,
      identityCheck: { verified: false, reason: "verification pending" },
    };
    this.connections.add(session);
    socket.on("message", (data: unknown) => {
      try {
        this.onMessage(session, data);
      } catch {
        closeSocket(socket, CLOSE_CODES.PROTOCOL_ERROR, CLOSE_REASONS.PROTOCOL_ERROR);
      }
    });
    socket.on("close", () => this.onSessionClose(session));
    socket.on("error", () => {
      // The close handler performs the cleanup.
    });
  }

  private onMessage(session: Session, data: unknown): void {
    if (this.shuttingDown || session.socket.readyState !== 1) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, CLOSE_REASONS.PROTOCOL_ERROR);
      return;
    }
    let message: AnyTypedMessage;
    try {
      message = parseMessage(parsed);
    } catch {
      closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, CLOSE_REASONS.PROTOCOL_ERROR);
      return;
    }

    if (session.hello === null) {
      if (message.type !== "hello") {
        closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, "PROTOCOL_ERROR: hello must come first");
        return;
      }
      this.handleHello(session, message.payload);
      return;
    }

    if (message.brokerInstanceId !== this.brokerInstanceId || message.sessionId !== session.sessionId ||
        !(session.role === "entry"
          ? ["ping", "pong", "control.request", "task.submit", "approval.result"]
          : ["ping", "pong", "logs.batch", "clients.snapshot", "task.received", "task.result", "task.statusResult"]
        ).includes(message.type)) {
      closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, "PROTOCOL_ERROR: connection identity or role mismatch");
      return;
    }
    switch (message.type) {
      case "ping":
        this.send(session, "pong", { nonce: message.payload.nonce });
        return;
      case "pong":
        if (message.payload.nonce === session.outstandingPingNonce) {
          session.lastPongAt = Date.now();
          session.outstandingPingNonce = null;
        }
        return;
      case "control.request":
        if (session.role !== "entry") {
          closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, "PROTOCOL_ERROR: control channel is entry-only");
          return;
        }
        this.handleControlRequest(session, message.payload.requestId, message.payload.tool, message.payload.arguments);
        return;
      case "logs.batch":
      case "clients.snapshot":
        // Valid bridge telemetry pushes; this build has no consumer yet.
        return;
      case "task.submit":
      case "approval.result":
        closeSocket(
          session.socket,
          CLOSE_CODES.PROTOCOL_ERROR,
          "PROTOCOL_ERROR: the FIFO/task pipeline is not implemented in this build",
        );
        return;
      default:
        closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, "PROTOCOL_ERROR: message not servable in this build");
    }
  }

  private handleHello(session: Session, hello: Hello): void {
    if (hello.role !== session.role) {
      closeSocket(session.socket, CLOSE_CODES.UNAUTHORIZED, `${CLOSE_REASONS.UNAUTHORIZED}: hello role does not match the route`);
      return;
    }
    if (hello.buildId !== BUILD_ID) {
      closeSocket(session.socket, CLOSE_CODES.BUILD_MISMATCH, `${CLOSE_REASONS.BUILD_MISMATCH}: broker is ${BUILD_ID}`);
      return;
    }
    if (hello.role === "entry") {
      if (hello.configDigest !== this.loaded.configDigest) {
        closeSocket(session.socket, CLOSE_CODES.CONFIG_MISMATCH, CLOSE_REASONS.CONFIG_MISMATCH);
        return;
      }
    } else if (this.bridgeSession !== null) {
      closeSocket(session.socket, CLOSE_CODES.BRIDGE_ALREADY_CONNECTED, CLOSE_REASONS.BRIDGE_ALREADY_CONNECTED);
      return;
    }

    session.hello = hello;
    session.registered = true;
    clearTimeout(session.handshakeTimer);
    this.sessions.set(session.sessionId, session);
    if (hello.role === "bridge") {
      this.bridgeSession = session;
      void verifyProcessIdentity(hello.environment).then(check => { session.identityCheck = check; });
    }
    this.send(session, "welcome", {
      brokerInstanceId: this.brokerInstanceId,
      sessionId: session.sessionId,
      capacity: {
        maxQueued: LIMITS.queue.maxQueued,
        maxRunningOrUnknown: LIMITS.queue.maxRunningOrUnknown,
        maxPendingApprovalsPerEntry: LIMITS.approval.maxPendingPerEntry,
        frameMaxBytes: LIMITS.message.frameMaxBytes,
      },
    });
    this.updateGrace();
  }

  private handleControlRequest(
    session: Session,
    requestId: string,
    tool: string,
    args: unknown,
  ): void {
    if (tool !== "status" || !REGISTERED_TOOLS.includes(tool as never)) {
      this.send(session, "control.result", {
        requestId,
        error: {
          code: "INVALID_ARGUMENT",
          message: `tool is not registered in this build; served tools: ${REGISTERED_TOOLS.join(", ")}`,
        },
      });
      return;
    }
    const parsed = StatusInputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      this.send(session, "control.result", {
        requestId,
        error: {
          code: "INVALID_ARGUMENT",
          message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
        },
      });
      return;
    }
    this.send(session, "control.result", {
      requestId,
      result: this.buildStatus(parsed.data.clientId),
    });
  }

  private buildStatus(clientId?: number): Record<string, unknown> {
    let entryCount = 0;
    for (const session of this.sessions.values()) {
      if (session.role === "entry") entryCount += 1;
    }
    const bridge = this.bridgeSession;
    const bridgeHello = bridge?.hello?.role === "bridge" ? bridge.hello : null;
    const recoveryFile = this.recovery.ok ? this.recovery.file : null;
    const dispatchBlockedReason =
      this.recovery.ok
        ? this.recoveryWriteError ?? (recoveryFile?.pending ? `UNRESOLVED_TASK: ${recoveryFile.pending.taskId}` : null)
        : `STATE_STORE_ERROR: ${this.recovery.message}`;
    return {
      brokerInstanceId: this.brokerInstanceId,
      pid: process.pid,
      startedAt: this.startedAt.toISOString(),
      uptimeMs: Date.now() - this.startedAt.getTime(),
      buildId: BUILD_ID,
      internalProtocol: 1,
      configDigest: this.loaded.configDigest,
      serverLabel: this.loaded.config.serverLabel,
      shuttingDown: this.shuttingDown,
      connectedEntries: entryCount,
      bridge:
        bridgeHello === null || bridge === null
          ? null
          : {
              environment: { ...bridgeHello.environment, serverIdentityVerifiable: bridge.identityCheck.verified },
              reportedEnvironment: bridgeHello.environment,
              identityVerification: bridge.identityCheck,
              buildId: bridgeHello.buildId,
              adapterDigest: bridgeHello.adapterDigest,
              adapterCompatibility: { verified: false, reason: "adapter manifest not implemented" },
              connectedAt: bridge.connectedAt,
            },
      // Client bindings arrive with the real FiveM bridge (later slice);
      // the optional clientId filter is applied for contract fidelity.
      clients: [],
      queue: {
        state: dispatchBlockedReason === null ? "idle" : "blocked",
        queued: 0,
        runningOrUnknown: recoveryFile?.pending ? 1 : 0,
        note: "scheduler not implemented in this build",
      },
      recovery: {
        status: this.recovery.ok
          ? this.recoveryWriteError === null
            ? "ok"
            : "write-error"
          : "corrupt",
        code: this.recovery.ok
          ? this.recoveryWriteError === null
            ? undefined
            : "STATE_STORE_ERROR"
          : "STATE_STORE_ERROR",
        message: this.recovery.ok ? this.recoveryWriteError ?? undefined : this.recovery.message,
        pendingTaskId: recoveryFile?.pending?.taskId ?? null,
        historyEntries: recoveryFile?.history.length ?? 0,
      },
      dispatchBlocked: dispatchBlockedReason !== null,
      dispatchBlockedReason,
      limits: LIMITS,
      registeredTools: [...REGISTERED_TOOLS],
      screenshot: {
        implemented: SCREENSHOT_IMPLEMENTED,
        enabled: SCREENSHOT_ENABLED,
      },
    };
  }

  private send(session: Session, type: MessageEnvelope["type"], payload: unknown): void {
    try {
      session.socket.send(
        JSON.stringify(
          envelopeOf(type, payload, {
            brokerInstanceId: this.brokerInstanceId,
            sessionId: session.sessionId,
          }),
        ),
      );
    } catch {
      closeSocket(session.socket, CLOSE_CODES.PROTOCOL_ERROR, "send failed");
    }
  }

  private heartbeatTick(session: Session): void {
    if (this.shuttingDown || !session.registered) return;
    if (Date.now() - session.lastPongAt > LIMITS.heartbeat.lossAfterMs) {
      closeSocket(session.socket, CLOSE_CODES.HEARTBEAT_LOST, CLOSE_REASONS.HEARTBEAT_LOST);
      return;
    }
    const nonce = randomUUID();
    session.outstandingPingNonce = nonce;
    this.send(session, "ping", { nonce });
  }

  private onSessionClose(session: Session): void {
    this.connections.delete(session);
    clearTimeout(session.handshakeTimer);
    clearInterval(session.heartbeatTimer);
    if (session.registered) {
      this.sessions.delete(session.sessionId);
      if (this.bridgeSession === session) {
        this.bridgeSession = null;
      }
    }
    this.updateGrace();
  }

  private updateGrace(): void {
    let entryCount = 0;
    for (const session of this.sessions.values()) {
      if (session.role === "entry") entryCount += 1;
    }
    if (this.shuttingDown) return;
    if (entryCount > 0) {
      if (this.graceTimer !== null) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }
      return;
    }
    if (this.graceTimer === null) {
      // Covers both "last entry disconnected" and "no entry ever arrived"
      // (abandoned startup) with the same RFC §4.3 grace period.
      this.graceTimer = setTimeout(() => {
        void this.shutdown("grace period elapsed");
      }, LIMITS.gracePeriodMs);
    }
  }

  /** Stop serving, close every connection, release handles, and exit. */
  async shutdown(reason: string): Promise<void> {
    if (this.shuttingDown) return this.shutdownPromise;
    this.shuttingDown = true;
    process.stderr.write(`fiveai-mcp broker shutting down: ${reason}\n`);
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    for (const session of this.connections) {
      clearTimeout(session.handshakeTimer);
      clearInterval(session.heartbeatTimer);
      closeSocket(session.socket, CLOSE_CODES.SHUTTING_DOWN, CLOSE_REASONS.SHUTTING_DOWN);
      session.socket.terminate();
    }
    if (this.app !== null) {
      const app = this.app;
      this.app = null;
      await app.close();
    }
    await this.releaseLifetimePipe();
    this.exitResolve?.();
  }
}
