/**
 * FiveAI local HTTP MCP resource: an MCP Streamable HTTP endpoint that
 * runs inside a FiveM server resource.
 *
 * Source of truth: `.notes/fivem-mcp-http/rfcs/fivem-resource-http-mcp-rfc.md`
 * (§2, §4, §5, §10) and `.notes/fivem-mcp-http/specs/fivem-mcp-http-migration-design.md`
 * (§2, §4, §5, §10). It keeps native calls on the host tick and exposes a
 * loopback-only HTTP endpoint.
 *
 *   1. Node HTTP — can the resource bind a loopback listener at all, and does
 *      binding have to happen on the host tick?
 *   2. SDK transport — does `StreamableHTTPServerTransport` (which converts
 *      through `@hono/node-server`) initialize and serve tools, and which Web
 *      APIs does the runtime actually provide?
 *   3. Host-tick switching — every libuv callback (HTTP request, socket data,
 *      body read, MCP request) must stay free of natives; native access is
 *      queued to `setTick`. The offline shim fails the run if this breaks.
 *   4. Stop cleanup — does `onResourceStop` actually release the listener,
 *      the SSE streams and the keep-alive sockets, so the port rebinds?
 *   5. Isolated compilation — can the bundled TypeScript compiler run, and is
 *      `node:worker_threads` available to move it off the control path?
 *
 * The HTTP contract values live in `./frozen.ts`.
 */

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import ts from "typescript";
import { FROZEN, isAllowedHost, isAllowedOrigin, resolveHttpPort } from "./frozen.ts";

const RESOURCE = GetCurrentResourceName();
const RESOURCE_EPOCH = randomUUID();
const PROCESS_STARTED_AT = Date.now();
/** Effective listen port; defaults to the RFC-frozen 30130 (see ./frozen.ts). */
const HTTP_PORT = resolveHttpPort(process.env["FIVEAI_MCP_HTTP_PORT"]);

/** RFC §5 state machine; `failed` is terminal until the resource restarts. */
type Phase = "starting" | "ready" | "stopping" | "stopped" | "failed";

let phase: Phase = "starting";
let httpServer: Server | null = null;
let capabilities: CapabilityReport | null = null;

const counters = {
  requests: 0,
  rejectedHost: 0,
  rejectedOrigin: 0,
  notFound: 0,
  methodNotAllowed: 0,
  bodyTooLarge: 0,
  malformedBody: 0,
  missingSession: 0,
  unknownSession: 0,
  sessionCapRejected: 0,
  hostQueueOverflow: 0,
  /** Native calls that crossed to the host thread; must equal nativeReads. */
  tickDrains: 0,
};

interface CapabilityReport {
  resource: string;
  resourceEpoch: string;
  build: string;
  node: { version: string; platform: string; arch: string; pid: number };
  webApis: Record<string, boolean>;
  workerThreads: { available: boolean; detail: string } | null;
  compiler: { module: string; version: string } | null;
  listener: { host: string; port: number; path: string };
}

function report(tag: string, payload: unknown): void {
  console.log(`FIVEAI_MCP ${tag} ${JSON.stringify(payload)}`);
}

/*
 * Host-tick queue (RFC §2: libuv callbacks run off the host thread).
 *
 * Nothing in the request path may touch a native. Anything that needs the
 * host thread is pushed here and drained by the single `setTick` callback,
 * which is also where the resource binds its listener.
 */

interface HostWork {
  readonly run: () => unknown;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const MAX_HOST_QUEUE = 128;
const hostQueue: HostWork[] = [];

function onHostTick<T>(run: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (hostQueue.length >= MAX_HOST_QUEUE) {
      counters.hostQueueOverflow += 1;
      reject(new Error("host queue full"));
      return;
    }
    hostQueue.push({
      run: run as () => unknown,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
  });
}

function webApiReport(): Record<string, boolean> {
  const names = [
    "Request",
    "Response",
    "Headers",
    "ReadableStream",
    "WritableStream",
    "TransformStream",
    "TextEncoder",
    "TextDecoder",
    "AbortController",
    "structuredClone",
    "fetch",
  ];
  const scope = globalThis as unknown as Record<string, unknown>;
  return Object.fromEntries(names.map((name) => [name, typeof scope[name] === "function"]));
}

/**
 * Probe 5a (RFC §6.3): can a worker be started in the resource runtime? The
 * answer decides whether isolated compilation is possible or whether HTTP MCP has
 * to report a technical blocker instead. Failures are ordinary results here,
 * never a reason to abort startup.
 */
async function probeWorkerThreads(): Promise<{ available: boolean; detail: string }> {
  try {
    const { Worker } = await import("node:worker_threads");
    const reply = await new Promise<unknown>((resolve, reject) => {
      const worker = new Worker(
        "const { parentPort } = require('node:worker_threads'); parentPort.postMessage(41 + 1);",
        { eval: true },
      );
      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("worker did not reply within 3000ms"));
      }, 3000);
      worker.once("message", (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      });
      worker.once("error", (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return { available: true, detail: `eval worker replied ${String(reply)}` };
  } catch (error) {
    return { available: false, detail: (error as Error).message };
  }
}

/*
 * HTTP boundary (RFC §4.1). Host and Origin are validated here rather than
 * through the SDK's `allowedHosts`/`allowedOrigins` options, which SDK 1.30.0
 * marks deprecated in favour of external middleware. No CORS header is ever
 * returned, and no Authorization, Cookie or Token is required or read.
 */

function sendStatus(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

type BodyRead = { ok: true; text: string } | { ok: false; reason: "too_large" | "read_error" };

/**
 * Read the request body under the RFC §4.2 ceiling. This runs on the libuv
 * thread and therefore only touches buffers.
 */
function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (value: BodyRead): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > FROZEN.maxBodyBytes) {
        // Stop accumulating; the caller answers 413 and destroys the socket so
        // a client cannot keep streaming an unbounded body.
        chunks.length = 0;
        settle({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => settle({ ok: true, text: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => settle({ ok: false, reason: "read_error" }));
    req.on("aborted", () => settle({ ok: false, reason: "read_error" }));
  });
}

function sessionHeader(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"];
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function looksLikeInitialize(body: unknown): boolean {
  const first = Array.isArray(body) ? (body as unknown[])[0] : body;
  if (typeof first !== "object" || first === null) return false;
  return (first as { method?: unknown }).method === "initialize";
}

/*
 * Sessions (RFC §4.2). One MCP Server and one transport per initialize; the
 * session id is generated up front so the registry key is known before the
 * transport reports it. The tool services are shared.
 */

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  readonly createdAt: number;
  closed: boolean;
}

const sessions = new Map<string, SessionEntry>();
let pendingInitialize = 0;

async function closeSession(entry: SessionEntry): Promise<void> {
  if (entry.closed) return;
  entry.closed = true;
  try {
    await entry.server.close();
  } catch {
    // Already closed, or the underlying transport is gone; either way there is
    // nothing left to release.
  }
  try {
    await entry.transport.close();
  } catch {
    // See above. Closing twice must not throw out of the shutdown path.
  }
}

function createSession(): StreamableHTTPServerTransport {
  pendingInitialize += 1;
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    // RFC §4.1: POST carries JSON-RPC and GET carries SSE, so a POST answer is
    // a plain JSON response rather than a request-scoped event stream.
    enableJsonResponse: true,
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      pendingInitialize -= 1;
      sessions.set(sessionId, { transport, server, createdAt: Date.now(), closed: false });
      report("session-open", { sessionId, active: sessions.size });
    },
    onsessionclosed: (sessionId) => {
      const entry = sessions.get(sessionId);
      sessions.delete(sessionId);
      report("session-close", { sessionId, active: sessions.size });
      if (entry !== undefined) void closeSession(entry);
    },
  });
  transport.onclose = () => {
    for (const [sessionId, entry] of sessions) {
      if (entry.transport !== transport) continue;
      sessions.delete(sessionId);
      void closeSession(entry);
    }
  };
  void server.connect(transport);
  return transport;
}

/**
 * Release a transport whose initialize never produced a session (bad version,
 * bad media type, malformed params). Without this the refused attempt would
 * hold a cap slot forever and a client could wedge the endpoint with repeated
 * bad handshakes.
 */
function dropProvisional(transport: StreamableHTTPServerTransport): void {
  pendingInitialize = Math.max(0, pendingInitialize - 1);
  void transport.close().catch(() => undefined);
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const sessionId = sessionHeader(req);
  if (sessionId === undefined) {
    if (req.method !== "POST") {
      counters.missingSession += 1;
      sendStatus(res, 400, "missing mcp-session-id header");
      return;
    }
    const body = await readBody(req);
    if (!body.ok) {
      if (body.reason === "too_large") {
        counters.bodyTooLarge += 1;
        // `connection: close` lets the response flush instead of resetting the
        // socket under the client; readBody has already put the request into
        // flowing mode, so the remaining bytes are discarded, not buffered.
        sendStatus(res, 413, "request body exceeds the configured limit", { connection: "close" });
        return;
      }
      sendStatus(res, 400, "request body could not be read");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      counters.malformedBody += 1;
      sendStatus(res, 400, "request body is not valid JSON");
      return;
    }
    if (!looksLikeInitialize(parsed)) {
      counters.missingSession += 1;
      sendStatus(res, 400, "a session id is required for non-initialize requests");
      return;
    }
    if (sessions.size + pendingInitialize >= FROZEN.maxSessions) {
      counters.sessionCapRejected += 1;
      sendStatus(res, 503, "session limit reached");
      return;
    }
    const transport = createSession();
    try {
      await transport.handleRequest(req, res, parsed);
    } finally {
      if (transport.sessionId === undefined) dropProvisional(transport);
    }
    return;
  }

  const entry = sessions.get(sessionId);
  if (entry === undefined) {
    counters.unknownSession += 1;
    sendStatus(res, 404, "unknown or expired session");
    return;
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    if (!body.ok) {
      if (body.reason === "too_large") {
        counters.bodyTooLarge += 1;
        sendStatus(res, 413, "request body exceeds the configured limit", { connection: "close" });
        return;
      }
      sendStatus(res, 400, "request body could not be read");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      counters.malformedBody += 1;
      sendStatus(res, 400, "request body is not valid JSON");
      return;
    }
    await entry.transport.handleRequest(req, res, parsed);
    return;
  }
  await entry.transport.handleRequest(req, res);
}

/** The request listener itself is a libuv callback: no natives below. */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  counters.requests += 1;
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  if (path !== FROZEN.httpPath) {
    counters.notFound += 1;
    sendStatus(res, 404, "not found");
    return;
  }
  if (!isAllowedHost(req.headers.host, HTTP_PORT)) {
    counters.rejectedHost += 1;
    sendStatus(res, 403, "host not allowed");
    return;
  }
  if (!isAllowedOrigin(req.headers.origin, HTTP_PORT)) {
    counters.rejectedOrigin += 1;
    sendStatus(res, 403, "origin not allowed");
    return;
  }
  if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
    counters.methodNotAllowed += 1;
    sendStatus(res, 405, "method not allowed", { allow: "POST, GET, DELETE" });
    return;
  }
  routeRequest(req, res).catch((error: unknown) => {
    report("request-error", { message: (error as Error).message });
    sendStatus(res, 500, "internal error");
  });
}

/*
 * Tools currently implemented by the HTTP MCP resource.
 */

const TOOLS = [
  {
    name: "status",
    description:
      "Report listener, session, boundary-counter, and runtime capability state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
  },
  {
    name: "native_read",
    description:
      "Read-only FiveM natives evaluated on the host tick. Proves that a tools/call request reaches the host thread and that natives never run on the libuv thread.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } as const,
  },
  {
    name: "compile_ts",
    description:
      "Transpile a bounded TypeScript snippet in-process and report the elapsed time, to measure how much synchronous compiler work would block control queries.",
    inputSchema: {
      type: "object",
      properties: { source: { type: "string", maxLength: FROZEN.maxCodeBytes } },
      additionalProperties: false,
    } as const,
  },
] as const;

const DEFAULT_COMPILE_SOURCE = [
  "export interface ProbeInput { readonly label: string }",
  "export async function probe(input: ProbeInput): Promise<string> {",
  "  const parts = [input.label, 'mcp'].filter(Boolean);",
  "  return parts.join(':');",
  "}",
].join("\n");

function textResult(value: unknown): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(code: string, message: string): {
  content: { type: "text"; text: string }[];
  structuredContent: { error: { code: string; message: string } };
  isError: true;
} {
  const error = { code, message };
  return {
    isError: true,
    structuredContent: { error },
    content: [{ type: "text", text: JSON.stringify({ error }, null, 2) }],
  };
}

function statusPayload(): Record<string, unknown> {
  return {
    service: "fivem-mcp/1",
    phase,
    resource: RESOURCE,
    resourceEpoch: RESOURCE_EPOCH,
    build: __HTTP_MCP_BUILD__,
    uptimeMs: Date.now() - PROCESS_STARTED_AT,
    http: {
      listening: httpServer?.listening === true,
      address: `http://${FROZEN.httpHost}:${HTTP_PORT}${FROZEN.httpPath}`,
    },
    sessions: { active: sessions.size, pendingInitialize, max: FROZEN.maxSessions },
    counters: { ...counters },
    capabilities,
  };
}

function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "status":
      return Promise.resolve(textResult(statusPayload()));
    case "native_read":
      return onHostTick(() => {
        counters.tickDrains += 1;
        return textResult({
          resource: GetCurrentResourceName(),
          resourceState: GetResourceState(RESOURCE),
          resourceCount: GetNumResources(),
          gameTimerMs: GetGameTimer(),
          executedOnHostTick: true,
        });
      });
    case "compile_ts": {
      const requested = args["source"];
      const source = typeof requested === "string" ? requested : DEFAULT_COMPILE_SOURCE;
      if (Buffer.byteLength(source, "utf8") > FROZEN.maxCodeBytes) {
        return Promise.resolve(errorResult("INVALID_ARGUMENT", "source exceeds the code budget"));
      }
      const started = Date.now();
      const output = ts.transpileModule(source, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.ESNext,
          removeComments: false,
        },
        reportDiagnostics: false,
      });
      return Promise.resolve(
        textResult({
          javascript: output.outputText,
          sourceBytes: Buffer.byteLength(source, "utf8"),
          elapsedMs: Date.now() - started,
          ranOnLibuvThread: true,
        }),
      );
    }
    default:
      return Promise.resolve(errorResult("INVALID_ARGUMENT", `unknown tool: ${name}`));
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: "fiveai-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...TOOLS] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(request.params.name, args);
    return result as { content: { type: "text"; text: string }[] };
  });
  return server;
}

/*
 * Lifecycle (RFC §5). Boot, listen and every native call happen on the host
 * tick; stop releases the listener, the sessions and the sockets.
 */

function boot(): void {
  capabilities = {
    resource: RESOURCE,
    resourceEpoch: RESOURCE_EPOCH,
    build: __HTTP_MCP_BUILD__,
    node: { version: process.version, platform: process.platform, arch: process.arch, pid: process.pid },
    webApis: webApiReport(),
    workerThreads: null,
    compiler: { module: "typescript", version: ts.version },
    listener: { host: FROZEN.httpHost, port: HTTP_PORT, path: FROZEN.httpPath },
  };
  report("capabilities", capabilities);

  void probeWorkerThreads().then((result) => {
    // RFC §5: a late async callback must check the stop flag rather than write
    // into a run that has already ended.
    if (phase === "stopping" || phase === "stopped" || phase === "failed") return;
    if (capabilities !== null) capabilities.workerThreads = result;
    report("worker-probe", result);
  });

  const server = createServer(handleRequest);
  httpServer = server;
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("error", (error: NodeJS.ErrnoException) => {
    // RFC §5: a busy port is reported, never worked around. The raw errno is
    // kept alongside the contract name so the host log is unambiguous.
    phase = "failed";
    report("listen-error", {
      reason: error.code === "EADDRINUSE" ? "PORT_IN_USE" : "LISTEN_FAILED",
      errno: error.code ?? "UNKNOWN",
      message: error.message,
    });
  });
  server.listen(HTTP_PORT, FROZEN.httpHost, () => {
    phase = "ready";
    report("ready", {
      address: `http://${FROZEN.httpHost}:${HTTP_PORT}${FROZEN.httpPath}`,
      resourceEpoch: RESOURCE_EPOCH,
      build: __HTTP_MCP_BUILD__,
      // Module evaluation to serving: the cost of loading the bundled 10 MB
      // compiler shows up here, so a slow host start is measurable, not guesswork.
      bootElapsedMs: Date.now() - PROCESS_STARTED_AT,
    });
  });
}

setTick(() => {
  if (phase === "starting") boot();
  if (phase === "stopping" || phase === "stopped") return;
  for (let drained = 0; drained < 32 && hostQueue.length > 0; drained += 1) {
    const item = hostQueue.shift();
    if (item === undefined) break;
    try {
      item.resolve(item.run());
    } catch (error) {
      item.reject(error);
    }
  }
});

/** Bind and immediately release the port: the direct proof that stop freed it. */
function probeRebindable(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    probe.once("error", () => settle(false));
    probe.listen(HTTP_PORT, FROZEN.httpHost, () => {
      probe.close(() => settle(true));
    });
  });
}

function closeListener(): Promise<boolean> {
  const server = httpServer;
  if (server === null) return Promise.resolve(true);
  httpServer = null;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
      resolve(false);
    }, 5_000);
    server.close(() => {
      clearTimeout(timer);
      void probeRebindable().then(resolve);
    });
    // A single keep-alive socket from a connected client would otherwise keep
    // close() pending for the whole HTTP keep-alive timeout.
    server.closeAllConnections();
  });
}

async function stop(reason: string): Promise<void> {
  if (phase === "stopping" || phase === "stopped") return;
  phase = "stopping";
  const startedStop = Date.now();
  // Queued host work must not run after the resource is gone.
  for (const item of hostQueue.splice(0)) item.reject(new Error("resource stopping"));
  const openSessions = [...sessions.entries()];
  sessions.clear();
  pendingInitialize = 0;
  await Promise.all(openSessions.map(([, entry]) => closeSession(entry)));
  const rebindable = await closeListener();
  phase = "stopped";
  report("stop", {
    reason,
    resourceEpoch: RESOURCE_EPOCH,
    sessionsClosed: openSessions.length,
    listenerReleased: rebindable,
    elapsedMs: Date.now() - startedStop,
  });
}

on("onResourceStop", (...args: unknown[]) => {
  const name = typeof args[0] === "string" ? args[0] : undefined;
  if (name !== RESOURCE) return;
  void stop("resource-stop");
});

/** Server-console evidence dump, for collecting host results in one line. */
RegisterCommand(
  "fiveai_mcp_report",
  (source: number) => {
    if (Number(source) !== 0) return;
    report("report", statusPayload());
  },
  true,
);

report("load", { resource: RESOURCE, resourceEpoch: RESOURCE_EPOCH, build: __HTTP_MCP_BUILD__ });
