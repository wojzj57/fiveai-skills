/**
 * stdio entry (RFC §4). One entry process per AI client. It speaks MCP on
 * stdio, ensures first-run credentials exist (unified-artifact RFC §5),
 * discovers or spawns the shared broker, and forwards tool calls over the
 * authenticated internal WebSocket. Only genuinely servable tools are
 * registered — in this slice exactly `status`.
 *
 * Diagnostics go to stderr only; stdout belongs to the MCP protocol.
 * The entry never re-sends a tool operation after a reconnect (RFC §4.3):
 * in-flight requests fail with TARGET_UNAVAILABLE and the caller decides.
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LIMITS } from "../protocol/limits.ts";
import { parseMessage, type AnyTypedMessage, type MessageEnvelope } from "../protocol/envelope.ts";
import { CLOSE_CODES } from "../protocol/close-codes.ts";
import { StatusInputSchema, toolInputJsonSchema } from "../tools/schemas.ts";
import { loadConfig, type LoadedConfig, type LoadedRuntimeConfig } from "./config.ts";
import { ensureCredentials } from "./credentials.ts";
import {
  acquirePipeMutex,
  brokerPipeNames,
  probeLifetimePipe,
  waitForLifetimeDiscovery,
  type DiscoveryInfo,
} from "../broker/pipes.ts";
import { BUILD_ID, PACKAGE_VERSION } from "../build.ts";

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_BROKER_UNAVAILABLE = 3;
/** Credential phase failures: missing-but-uninitializable, corrupt, linked, boundary violations, busy (unified-artifact RFC §5). */
const EXIT_CREDENTIAL_FAILURE = 4;
const EXIT_UNEXPECTED = 1;

const STATUS_TOOL_DESCRIPTION =
  "Report the live FiveM debug broker status: connection state, server bridge identity, " +
  "connected clients, queue state, recovery/dispatch state, and effective limits. " +
  "Read-only; available even when FiveM is not connected. Pass clientId to filter the client list display only.";

const BROKER_SPAWN_TIMEOUT_MS = 20_000;
const CONNECT_WAIT_MS = 20_000;
/**
 * How long the entry keeps re-probing around a dying broker generation
 * (occupied pipe, spawn racing the old service's exit) before declaring
 * INSTANCE_CONFLICT — RFC §4.3: new entries re-probe after the old service
 * has exited instead of failing or spawning a second scheduler.
 */
const DISCOVERY_RETRY_MS = 15_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

interface PendingControl {
  resolve: (value: { result?: unknown; error?: { code: string; message: string } }) => void;
  timer: NodeJS.Timeout;
}

function fatal(message: string, code: number): never {
  process.stderr.write(`fiveai-mcp entry: ${message}\n`);
  process.exit(code);
}

function brokerScriptPath(): string {
  const self = fileURLToPath(new URL(import.meta.url));
  if (self.endsWith(".ts")) {
    // Dev/source mode: run the broker from the source tree.
    return fileURLToPath(new URL("../broker/main.ts", import.meta.url));
  }
  return fileURLToPath(new URL("./broker.mjs", import.meta.url));
}

/**
 * The no-argument entry locates the config next to itself
 * (unified-artifact RFC §4); a missing file is an incomplete installation,
 * never silently replaced by another directory's config.
 */
function defaultConfigPath(): string {
  return fileURLToPath(new URL("./config.json", import.meta.url));
}

const USAGE = "usage: node entry.mjs [--config <absolute-config-path>]";

class BrokerLink {
  private ws: WebSocket | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, PendingControl>();
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private brokerProcess: ChildProcess | null = null;
  private closedByUs = false;
  private brokerInstanceId: string | null = null;
  private sessionId: string | null = null;

  private readonly loaded: LoadedRuntimeConfig;
  private readonly pipes: { startup: string; lifetime: string };

  constructor(loaded: LoadedRuntimeConfig, pipes: { startup: string; lifetime: string }) {
    this.loaded = loaded;
    this.pipes = pipes;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Connect, spawning the broker when no valid service is discoverable. */
  async connect(): Promise<void> {
    if (this.closedByUs) throw new Error("entry link closed");
    if (this.connected) return;
    if (this.connecting === null) {
      this.connecting = this.connectOnce().catch(error => {
        this.scheduleReconnect();
        throw error;
      }).finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  private async connectOnce(): Promise<void> {
    const { config, configDigest } = this.loaded;
    const deadline = Date.now() + DISCOVERY_RETRY_MS;
    for (;;) {
      if (this.closedByUs) throw new Error("entry link closed");
      const probe = await probeLifetimePipe(this.pipes.lifetime);
      if (this.closedByUs) throw new Error("entry link closed");
      if (probe.status === "info") {
        if (probe.info.configDigest !== configDigest) {
          fatal(
            `INSTANCE_CONFLICT: a broker for a different configuration is already running (digest ${probe.info.configDigest})`,
            EXIT_BROKER_UNAVAILABLE,
          );
        }
        await this.openEntryWebSocket();
        return;
      }
      if (probe.status === "occupied") {
        // Possibly an old generation shutting down; re-probe before
        // declaring an unresolvable conflict.
        if (Date.now() >= deadline) {
          fatal(
            "INSTANCE_CONFLICT: the lifetime pipe is occupied by a process that cannot be verified as this configuration's broker",
            EXIT_BROKER_UNAVAILABLE,
          );
        }
        await sleep(400);
        continue;
      }
      const info = await this.ensureBrokerStarted();
      if (info === null) {
        if (Date.now() >= deadline) {
          fatal(
            "PORT_IN_USE/BROKER_START_TIMEOUT: no broker appeared on the lifetime pipe after the startup attempt",
            EXIT_BROKER_UNAVAILABLE,
          );
        }
        await sleep(400);
        continue;
      }
      if (info.configDigest !== configDigest) {
        fatal(
          `INSTANCE_CONFLICT: a broker for a different configuration answered (digest ${info.configDigest})`,
          EXIT_BROKER_UNAVAILABLE,
        );
      }
      await this.openEntryWebSocket();
      return;
    }
  }

  private openEntryWebSocket(): Promise<void> {
    if (this.closedByUs) return Promise.reject(new Error("entry link closed"));
    const { config, configDigest } = this.loaded;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://${config.broker.host}:${config.broker.port}/internal/v1/entry`,
        { headers: { Authorization: `Bearer ${this.loaded.entryToken}` }, maxPayload: LIMITS.message.frameMaxBytes },
      );
      this.ws = ws;
      const handshakeTimeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("broker WebSocket handshake timed out"));
      }, 10_000);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            v: 1,
            id: randomUUID(),
            type: "hello",
            payload: {
              role: "entry",
              internalProtocol: 1,
              buildId: BUILD_ID,
              configDigest,
            },
          }),
        );
      });
      ws.on("message", (data: unknown) => {
        this.onFrame(data, { handshakeTimeout, resolve });
      });
      ws.on("close", (code: number, reason: Buffer) => {
        clearTimeout(handshakeTimeout);
        this.onClosed(code, reason.toString("utf8"), reject);
      });
      ws.on("error", () => {
        // The close handler carries the failure.
      });
    });
  }

  private async ensureBrokerStarted(): Promise<DiscoveryInfo | null> {
    const startupServer = await acquirePipeMutex(this.pipes.startup);
    if (startupServer !== null) {
      try {
        if (this.closedByUs) return null;
        const script = brokerScriptPath();
        if (!existsSync(script)) {
          fatal(`broker script not found next to the entry: ${script}`, EXIT_UNEXPECTED);
        }
        this.brokerProcess = spawn(process.execPath, [script, "--config", this.loaded.configPath], {
          detached: true,
          stdio: "ignore",
          windowsHide: true,
        });
        this.brokerProcess.unref();
        this.brokerProcess.on("error", error => {
          process.stderr.write(`fiveai-mcp entry: broker spawn failed: ${error.message}\n`);
        });
      } finally {
        // The startup mutex only needs to cover the spawn decision; the
        // broker's lifetime pipe is the real serialization point.
        await new Promise<void>((resolve) => startupServer.close(() => resolve()));
      }
    }
    return waitForLifetimeDiscovery(this.pipes.lifetime, BROKER_SPAWN_TIMEOUT_MS);
  }

  private onFrame(
    data: unknown,
    handshake: { handshakeTimeout: NodeJS.Timeout; resolve: () => void },
  ): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      this.ws?.close(CLOSE_CODES.PROTOCOL_ERROR, "invalid JSON");
      return;
    }
    let message: AnyTypedMessage | null = null;
    try {
      message = parseMessage(parsedJson);
    } catch {
      this.ws?.close(CLOSE_CODES.PROTOCOL_ERROR, "invalid protocol message");
      return;
    }
    if (message === null) return;
    const invalid = !this.connected
      ? message.type !== "welcome" || message.brokerInstanceId !== message.payload.brokerInstanceId || message.sessionId !== message.payload.sessionId
      : message.brokerInstanceId !== this.brokerInstanceId || message.sessionId !== this.sessionId ||
        !["ping", "pong", "control.result"].includes(message.type);
    if (invalid) {
      this.ws?.close(CLOSE_CODES.PROTOCOL_ERROR, "connection identity or role mismatch");
      return;
    }
    switch (message.type) {
      case "welcome":
        this.connected = true;
        this.brokerInstanceId = message.payload.brokerInstanceId;
        this.sessionId = message.payload.sessionId;
        this.reconnectAttempts = 0;
        if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
        clearTimeout(handshake.handshakeTimeout);
        handshake.resolve();
        return;
      case "ping":
        this.send("pong", { nonce: message.payload.nonce });
        return;
      case "control.result": {
        const pending = this.pending.get(message.payload.requestId);
        if (pending !== undefined) {
          this.pending.delete(message.payload.requestId);
          clearTimeout(pending.timer);
          if (message.payload.error !== undefined) {
            pending.resolve({ error: message.payload.error });
          } else {
            pending.resolve({ result: message.payload.result });
          }
        }
        return;
      }
      default:
        return;
    }
  }

  private onClosed(code: number, reason: string, handshakeReject: (error: Error) => void): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    this.failAllPending();
    if (this.closedByUs) return;
    if (code === CLOSE_CODES.CONFIG_MISMATCH || code === CLOSE_CODES.BUILD_MISMATCH) {
      fatal(`${reason || "CONFIG_MISMATCH/BUILD_MISMATCH"} (close code ${code})`, EXIT_BROKER_UNAVAILABLE);
    }
    if (!wasConnected) {
      handshakeReject(new Error(`broker connection closed before welcome (code ${code}, ${reason})`));
    } else {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUs || this.connected || this.reconnectTimer !== null) return;
    const { backoffScheduleMs, backoffCapMs } = LIMITS.bridgeReconnect;
    const base =
      backoffScheduleMs[Math.min(this.reconnectAttempts, backoffScheduleMs.length - 1)] ??
      backoffCapMs;
    const capped = Math.min(base, backoffCapMs);
    const jitter = Math.floor(Math.random() * Math.min(500, capped / 2));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUs || this.connected) return;
      this.connect().catch((error: unknown) => {
        process.stderr.write(`fiveai-mcp entry: reconnect failed: ${(error as Error).message}\n`);
      });
    }, capped + jitter).unref();
  }

  private failAllPending(): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      clearTimeout(pending.timer);
      pending.resolve({
        error: { code: "TARGET_UNAVAILABLE", message: "broker connection lost" },
      });
    }
  }

  private send(type: MessageEnvelope["type"], payload: unknown): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    // After the handshake every envelope carries the assigned identities
    // (RFC §5.1); only hello may omit them.
    ws.send(
      JSON.stringify({
        v: 1,
        id: randomUUID(),
        type,
        ...(this.brokerInstanceId === null ? {} : { brokerInstanceId: this.brokerInstanceId }),
        ...(this.sessionId === null ? {} : { sessionId: this.sessionId }),
        payload,
      }),
    );
  }

  /** Wait (bounded) for a live broker connection. */
  async waitForConnected(deadlineMs: number): Promise<boolean> {
    const deadline = Date.now() + deadlineMs;
    while (!this.closedByUs && !this.connected && Date.now() < deadline) {
      if (this.reconnectTimer === null) void this.connect().catch(() => {
        // Reconnect scheduling is handled inside the failure path.
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return this.connected;
  }

  /**
   * Forward a control-channel request and await its correlated result.
   * Overall deadline includes any connection wait (RFC §6.2 tool sync wait).
   */
  async callControl(
    deadlineMs: number,
    makePayload: (requestId: string) => unknown,
  ): Promise<{ result?: unknown; error?: { code: string; message: string } }> {
    const deadline = Date.now() + deadlineMs;
    if (!(await this.waitForConnected(deadline - Date.now()))) {
      return { error: { code: "TARGET_UNAVAILABLE", message: "broker connection is not established" } };
    }
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ error: { code: "TARGET_UNAVAILABLE", message: "broker did not respond in time" } });
      }, Math.max(1, deadline - Date.now()));
      this.pending.set(requestId, { resolve, timer });
      this.send("control.request", makePayload(requestId));
    });
  }

  close(): void {
    this.closedByUs = true;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.failAllPending();
    if (this.ws !== null) {
      try {
        this.ws.close(1000, "entry shutting down");
      } catch {
        // Ignore; process is exiting.
      }
    }
  }
}

async function main(): Promise<number> {
  // Argument contract (unified-artifact RFC §4): the no-argument form uses
  // the config next to the entry; --config keeps requiring an absolute
  // Windows path; anything else — extra, missing, duplicated, or relative
  // arguments — is a usage error.
  const argv = process.argv.slice(2);
  let configPath: string | null = null;
  if (argv.length === 0) {
    configPath = defaultConfigPath();
    if (!existsSync(configPath)) {
      process.stderr.write(
        `fiveai-mcp entry: no config.json next to the entry (${configPath}); the installation is incomplete or this is a dev checkout - pass --config <absolute-config-path>\n`,
      );
      return EXIT_USAGE;
    }
  } else if (argv.length === 2 && argv[0] === "--config") {
    const candidate = argv[1] ?? "";
    if (!/^([A-Za-z]:[\\/]|\\\\)/.test(candidate)) {
      process.stderr.write(`${USAGE}\n--config requires an absolute Windows path\n`);
      return EXIT_USAGE;
    }
    configPath = candidate;
  } else {
    process.stderr.write(`${USAGE}\n`);
    return EXIT_USAGE;
  }
  let base: LoadedConfig;
  try {
    base = loadConfig(configPath);
  } catch (error) {
    process.stderr.write(`fiveai-mcp entry: ${(error as Error).message}\n`);
    return EXIT_USAGE;
  }

  // First-run credential initialization happens before any broker
  // discovery (unified-artifact RFC §5.1).
  let credentials;
  try {
    credentials = await ensureCredentials(base.credentialFilePath);
  } catch (error) {
    process.stderr.write(`fiveai-mcp entry: credentials: ${(error as Error).message}\n`);
    return EXIT_CREDENTIAL_FAILURE;
  }
  const loaded: LoadedRuntimeConfig = {
    configPath: base.configPath,
    config: base.config,
    configDigest: base.configDigest,
    credentialFilePath: base.credentialFilePath,
    entryToken: credentials.entryToken,
    bridgeToken: credentials.bridgeToken,
  };

  const pipes = await brokerPipeNames();
  const link = new BrokerLink(loaded, pipes);
  void link.connect().catch((error: unknown) => {
    process.stderr.write(`fiveai-mcp entry: initial broker connection failed: ${(error as Error).message}\n`);
  });

  const server = new Server({ name: "fiveai-mcp", version: PACKAGE_VERSION }, {
    capabilities: { tools: {} },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "status",
        description: STATUS_TOOL_DESCRIPTION,
        inputSchema: toolInputJsonSchema("status") as {
          type: "object";
          properties?: Record<string, unknown>;
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== "status") {
      return {
        isError: true,
        content: [{ type: "text", text: `unknown tool: ${name}` }],
      };
    }
    const parsed = StatusInputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const error = {
        code: "INVALID_ARGUMENT",
        message: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      };
      return {
        isError: true,
        structuredContent: { error },
        content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
      };
    }
    const response = await link.callControl(CONNECT_WAIT_MS, (requestId) => ({
      requestId,
      tool: "status",
      arguments: parsed.data,
    }));
    if (response.error !== undefined) {
      return {
        isError: true,
        structuredContent: { error: response.error },
        content: [{ type: "text", text: JSON.stringify({ error: response.error }, null, 2) }],
      };
    }
    return {
      structuredContent: response.result,
      content: [{ type: "text", text: JSON.stringify(response.result, null, 2) }],
    };
  });

  server.onclose = () => {
    link.close();
    process.exit(EXIT_OK);
  };
  process.on("SIGTERM", () => {
    link.close();
    process.exit(EXIT_OK);
  });
  process.on("SIGINT", () => {
    link.close();
    process.exit(EXIT_OK);
  });

  await server.connect(new StdioServerTransport());
  // Keep the process alive for the WebSocket link until stdin closes.
  await new Promise(() => {});
  return EXIT_OK;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    process.stderr.write(`fiveai-mcp entry: unexpected failure: ${(error as Error).stack ?? error}\n`);
    process.exit(EXIT_UNEXPECTED);
  });
