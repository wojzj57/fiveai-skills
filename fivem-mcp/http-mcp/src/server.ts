/** Single-resource loopback MCP. Native work crosses HostScheduler. */
import {randomUUID} from 'node:crypto';
import {createServer,type IncomingMessage,type Server,type ServerResponse} from 'node:http';
import {Server as McpServer} from '@modelcontextprotocol/sdk/server/index.js';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {CallToolRequestSchema,ListToolsRequestSchema,McpError,ErrorCode} from '@modelcontextprotocol/sdk/types.js';
import {FROZEN,JSON_RPC,isAllowedHost,isAllowedOrigin,rpcError} from './frozen.ts';
import {loadConfig,type Config} from './shared/config.ts';
import {parseBounded,validate} from './shared/schema.ts';
import {HostScheduler} from './execution/host.ts';
import {RuntimeService} from './runtime-service.ts';
const RESOURCE=GetCurrentResourceName(),RESOURCE_EPOCH=randomUUID();
let HTTP_PORT:number=FROZEN.httpPort;
let phase:'starting'|'booting'|'ready'|'stopping'|'stopped'|'failed'='starting';
let httpServer:Server|null=null;
let service:RuntimeService|null=null;
const host=new HostScheduler();
let globalTokens=100,globalTokenTime=performance.now(),activeRequests=0;
const sockets=new Set<import('node:net').Socket>();
const counters={requests:0,rejectedHost:0,rejectedOrigin:0,notFound:0,methodNotAllowed:0,bodyTooLarge:0,bodyReadTimeout:0,malformedBody:0,missingSession:0,unknownSession:0,notInitialized:0,sessionCapRejected:0,rejectedProtocolVersion:0,unknownTool:0};
const report=(tag:string,payload:unknown)=>console.log('FIVEAI_MCP '+tag+' '+JSON.stringify(payload));
let maintenance:NodeJS.Timeout|undefined;
const requestSignals=new Map<string,AbortSignal>();
function sendStatus(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: message }, headers);
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * Protocol-level failure (§5): malformed JSON, a message we cannot accept, or
 * an unknown method/tool is answered with a JSON-RPC error object carrying the
 * standard `-32700`/`-32600`/`-32601`/`-32602` code, not a tool error wrapper.
 */
function sendRpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, rpcError(id, code, message));
}

type BodyRead =
  | { ok: true; text: string }
  | { ok: false; reason: "too_large" | "read_error" | "timeout" };

/**
 * Read the request body under the §3 ceiling and the §3 read budget. This runs
 * on the libuv thread and therefore only touches buffers.
 *
 * The budget matters: without it a client that announces a body and then stalls
 * holds the request (and everything already buffered) open forever, which the
 * probe previously allowed.
 */
function readBody(req: IncomingMessage): Promise<BodyRead> {
  return new Promise<BodyRead>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const timer = setTimeout(() => {
      // Stop buffering and answer 408; the caller closes the connection.
      chunks.length = 0;
      settle({ ok: false, reason: "timeout" });
    }, FROZEN.maxBodyReadMs);
    const settle = (value: BodyRead): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    req.on("data", (chunk: Buffer) => {
      if (settled) return;
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
    req.on("end", () => { try { settle({ok:true,text:new TextDecoder("utf-8",{fatal:true}).decode(Buffer.concat(chunks))}); } catch { settle({ok:false,reason:"read_error"}); } });
    req.on("error", () => settle({ ok: false, reason: "read_error" }));
    req.on("aborted", () => settle({ ok: false, reason: "read_error" }));
  });
}

/** JSON-RPC id of a parsed message, for the error object that must echo it. */
function messageId(parsed: unknown): unknown {
  const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
  if (typeof first !== "object" || first === null) return null;
  return (first as { id?: unknown }).id ?? null;
}

function messageMethod(parsed: unknown): string | undefined {
  const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
  if (typeof first !== "object" || first === null) return undefined;
  const method = (first as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function messageToolName(parsed: unknown): string | undefined {
  const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
  if (typeof first !== "object" || first === null) return undefined;
  const params = (first as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return undefined;
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
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
  readonly id: string;
  touchedAt: number;
  active: number;
  tokens: number;
  tokenTime: number;
  closed: boolean;
  /**
   * §4: "未收到 initialized 通知不能执行工具". The SDK does not gate tools/call
   * on that notification, so the entry tracks it and `routeRequest` refuses.
   */
  initialized: boolean;
}

const sessions = new Map<string, SessionEntry>();
let pendingInitialize = 0;

async function closeSession(entry: SessionEntry): Promise<void> {
  if (entry.closed) return;
  entry.closed = true;
  service?.sessionClosed(entry.id);
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
  const id = randomUUID();
  const server = createMcpServer(id);
  const transport = new StreamableHTTPServerTransport({
    // RFC §4.1: POST carries JSON-RPC and GET carries SSE, so a POST answer is
    // a plain JSON response rather than a request-scoped event stream.
    enableJsonResponse: false,
    sessionIdGenerator: () => id,
    onsessioninitialized: (sessionId) => {
      pendingInitialize -= 1;
      sessions.set(sessionId, {
        transport,
        server,
        createdAt: Date.now(),
        id, touchedAt: performance.now(), active:0, tokens:30, tokenTime:performance.now(),
        closed: false,
        initialized: false,
      });
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

/** Answer a body that could not be read (§3: 413 / 408 / 400). */
function respondBodyFailure(res: ServerResponse, reason: "too_large" | "read_error" | "timeout"): void {
  if (reason === "too_large") {
    counters.bodyTooLarge += 1;
    // `connection: close` lets the response flush instead of resetting the
    // socket under the client; readBody has already put the request into
    // flowing mode, so the remaining bytes are discarded, not buffered.
    sendStatus(res, 413, "request body exceeds the configured limit", { connection: "close" });
    return;
  }
  if (reason === "timeout") {
    counters.bodyReadTimeout += 1;
    sendStatus(res, 408, "request body was not sent within the read budget", { connection: "close" });
    return;
  }
  sendStatus(res, 400, "request body could not be read");
}

/** Methods a session may send before `notifications/initialized` (§4). */
const PRE_INITIALIZED_METHODS = new Set([
  "initialize",
  "ping",
  "notifications/initialized",
  "notifications/cancelled",
]);

/**
 * §4: this release speaks `2025-11-25` only, and an initialize asking for
 * another version must be answered with the version this end supports. The SDK
 * negotiates from its own wider list, so the requested version is pinned to
 * ours before the transport sees it and the client decides whether to continue.
 *
 * Deliberate trade-off: the request body is rewritten rather than rejected. The
 * MCP specification requires the server to answer an initialize with a version
 * it supports, and the SDK offers no hook for that; the rewrite is logged with
 * both the requested and the served version so nothing is hidden. Requests that
 * arrive after initialize are held to the same version through the
 * `mcp-protocol-version` header check in `handleRequest`.
 */
function lockProtocolVersion(parsed: unknown): void {
  const first = Array.isArray(parsed) ? (parsed as unknown[])[0] : parsed;
  if (typeof first !== "object" || first === null) return;
  const params = (first as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) return;
  const requested = (params as { protocolVersion?: unknown }).protocolVersion;
  if (typeof requested !== "string" || requested === FROZEN.protocolVersion) return;
  (params as { protocolVersion?: unknown }).protocolVersion = FROZEN.protocolVersion;
  report("protocol-version-pinned", { requested, served: FROZEN.protocolVersion });
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
      respondBodyFailure(res, body.reason);
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseBounded(body.text);
    } catch {
      counters.malformedBody += 1;
      sendRpcError(res, 400, null, JSON_RPC.parseError, "request body is not valid JSON");
      return;
    }
    if(Array.isArray(parsed)){sendRpcError(res,400,null,JSON_RPC.invalidRequest,"JSON-RPC batches are not supported");return;}
    if (!looksLikeInitialize(parsed)) {
      counters.missingSession += 1;
      sendRpcError(
        res,
        400,
        messageId(parsed),
        JSON_RPC.invalidRequest,
        "a session id is required for non-initialize requests",
      );
      return;
    }
    if (sessions.size + pendingInitialize >= FROZEN.maxSessions) {
      counters.sessionCapRejected += 1;
      // §3 gives 429 to the concurrency ceiling ("保留现有工作": refuse the new
      // session, never evict a live one). 503 belongs to the inbound-connection
      // budget, which this entry point does not track.
      sendStatus(res, 429, "session limit reached", { "retry-after": "1" });
      return;
    }
    lockProtocolVersion(parsed);
    const transport = createSession();
    try {
      await transport.handleRequest(req, res, parsed);
    } finally {
      if (transport.sessionId === undefined) dropProvisional(transport);
    }
    return;
  }

  const entry = sessions.get(sessionId);
  if (entry === undefined || entry.closed || (entry.active===0 && performance.now()-entry.touchedAt>1800000) || (!entry.initialized && performance.now()-entry.touchedAt>10000)) {
    if(entry){sessions.delete(sessionId);void closeSession(entry);}
    counters.unknownSession += 1;
    sendRpcError(res, 404, null, JSON_RPC.invalidRequest, "unknown or expired session");
    return;
  }
  const now=performance.now();
  entry.tokens=Math.min(30,entry.tokens+(now-entry.tokenTime)*0.03);entry.tokenTime=now;
  if(entry.active>=16||entry.tokens<1){sendStatus(res,429,"session request limit");return;}
  entry.tokens--;entry.active++;entry.touchedAt=now;
  res.once("close",()=>{entry.active--;entry.touchedAt=performance.now();});
  if (req.method === "DELETE") {
    // §4: deleting a session answers 204. The SDK's transport answers 200 on
    // this path, so the contract's value is produced here; the session and its
    // transport are released through the same close path used elsewhere.
    sessions.delete(sessionId);
    report("session-close", { sessionId, active: sessions.size });
    await closeSession(entry);
    res.writeHead(204).end();
    return;
  }
  if (req.method === "POST") {
    const body = await readBody(req);
    if (!body.ok) {
      respondBodyFailure(res, body.reason);
      return;
    }
    let parsed: unknown;
    try {
      parsed = parseBounded(body.text);
    } catch {
      counters.malformedBody += 1;
      sendRpcError(res, 400, null, JSON_RPC.parseError, "request body is not valid JSON");
      return;
    }
    if(Array.isArray(parsed)){sendRpcError(res,400,null,JSON_RPC.invalidRequest,"JSON-RPC batches are not supported");return;}
    const method = messageMethod(parsed);

    if (method !== undefined && !entry.initialized && !PRE_INITIALIZED_METHODS.has(method)) {
      counters.notInitialized += 1;
      sendRpcError(
        res,
        400,
        messageId(parsed),
        JSON_RPC.invalidRequest,
        "notifications/initialized has not been received for this session",
      );
      return;
    }
    // §5 puts an unknown tool at the JSON-RPC layer (`-32602`). Checking it here
    // keeps the HTTP status uniform with this end point's other protocol errors;
    // the same rejection inside the handler would come back as HTTP 200.
    if (method === "tools/call") {
      const name = messageToolName(parsed);
      if (name !== undefined && !service!.hasTool(name)) {
        counters.unknownTool += 1;
        sendRpcError(res, 400, messageId(parsed), JSON_RPC.invalidParams, `unknown tool: ${name}`);
        return;
      }
    }
    const stream=new AbortController(),key=sessionId+':'+String(messageId(parsed));
    requestSignals.set(key,stream.signal);res.once('close',()=>{stream.abort();requestSignals.delete(key);});
    await entry.transport.handleRequest(req, res, parsed);
    return;
  }
  await entry.transport.handleRequest(req, res);
}

/** The request listener itself is a libuv callback: no natives below. */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  counters.requests += 1;
  if(phase!=="ready"){sendStatus(res,503,"resource unavailable");return;}
  const now=performance.now();globalTokens=Math.min(100,globalTokens+(now-globalTokenTime)*0.1);globalTokenTime=now;
  if(activeRequests>=64||globalTokens<1){sendStatus(res,429,"request limit");return;}
  globalTokens--;activeRequests++;res.once("close",()=>activeRequests--);
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
  // §4: POST carries JSON-RPC and DELETE closes the session. GET is not
  // served — there is no standalone subscription and no Last-Event-ID replay,
  // and every elicitation travels on the original tools/call POST.
  if (req.method !== "POST" && req.method !== "DELETE") {
    counters.methodNotAllowed += 1;
    sendStatus(res, 405, "method not allowed", { allow: "POST, DELETE" });
    return;
  }
  /*
   * §4: "后续 header 显式不兼容则 400". This end point pins one protocol
   * version, so any other value in `mcp-protocol-version` is refused here
   * rather than by the SDK, whose supported list still holds older revisions
   * (2025-06-18, 2025-03-26, 2024-11-05, 2024-10-07) and would accept them.
   * A missing header is fine: the session already negotiated a version.
   */
  const declaredVersion = req.headers["mcp-protocol-version"];
  if (declaredVersion !== undefined && declaredVersion !== FROZEN.protocolVersion) {
    counters.rejectedProtocolVersion += 1;
    const declared = Array.isArray(declaredVersion) ? declaredVersion.join(", ") : declaredVersion;
    sendRpcError(res, 400, null, JSON_RPC.invalidRequest, `unsupported protocol version: ${declared}`);
    return;
  }
  routeRequest(req, res).catch((error: unknown) => {
    report("request-error", { message: (error as Error).message });
    sendStatus(res, 500, "internal error");
  });
}


function createMcpServer(sessionId:string):McpServer {
 const server=new McpServer({name:'fiveai-mcp',version:'0.1.0'},{capabilities:{tools:{listChanged:false}}});
 server.oninitialized=()=>{const entry=sessions.get(sessionId);if(entry&&!entry.closed)entry.initialized=true;};
 server.setRequestHandler(ListToolsRequestSchema,()=>({tools:service!.tools()}));
 server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
   const name=request.params.name,args=request.params.arguments??{};
   if(!service!.hasTool(name)||(!validate(name+'Input',args)||(name==='reference'&&!String(args.query).trim())))throw new McpError(ErrorCode.InvalidParams,'Unknown tool or invalid arguments');
   const result=await service!.call(name,args,sessionId,{server,requestId:extra.requestId,signal:AbortSignal.any([extra.signal,requestSignals.get(sessionId+':'+String(extra.requestId))??extra.signal])});
   if(!validate(name+'Output',result.structuredContent)||Buffer.byteLength(JSON.stringify(result))>1048576){
     const value={ok:false,error:{code:'RESULT_TOO_LARGE',message:'Response exceeded the output contract',phase:'read',execution:'not_applicable',retryable:false}};
     report('output-rejected',{tool:name});
     return {isError:true,structuredContent:value,content:[{type:'text',text:JSON.stringify(value)}]};
   }
   return result;
 });
 return server;
}
function boot():void {
 phase='booting';
 let resourcePath:string,config:Config;
 try{resourcePath=GetResourcePath(RESOURCE);config=loadConfig(RESOURCE);HTTP_PORT=config.port;}
 catch(error){phase='failed';report('config-error',{message:String(error)});return;}
 service=new RuntimeService({resourceName:RESOURCE,resourceEpoch:RESOURCE_EPOCH,buildId:__HTTP_MCP_BUILD__,resourcePath,config,host,sessionValid:id=>{const s=sessions.get(id);return !!s&&!s.closed&&(s.active>0||performance.now()-s.touchedAt<=1800000);},report});
 service.registerHost();
 setImmediate(()=>{
  if(phase!=='booting')return;
  const server=createServer({maxHeaderSize:16384},handleRequest);httpServer=server;
  server.on('connection',socket=>{if(sockets.size>=64){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
  server.on('clientError',(error,socket)=>{if((error as NodeJS.ErrnoException).code==='HPE_HEADER_OVERFLOW')socket.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');else socket.destroy();});
  server.on('error',(error:NodeJS.ErrnoException)=>{phase='failed';service?.stop();report('listen-error',{reason:error.code==='EADDRINUSE'?'PORT_IN_USE':'LISTEN_FAILED',errno:error.code,message:error.message});});
  server.listen(HTTP_PORT,FROZEN.httpHost,()=>{if(phase!=='booting')return;phase='ready';report('ready',{address:'http://127.0.0.1:'+HTTP_PORT+'/mcp',resourceEpoch:RESOURCE_EPOCH,build:__HTTP_MCP_BUILD__});});
  maintenance=setInterval(()=>{host.expire();for(const [id,s] of sessions)if((!s.initialized&&performance.now()-s.touchedAt>10000)||(s.active===0&&performance.now()-s.touchedAt>1800000)){sessions.delete(id);void closeSession(s);}},250);maintenance.unref();
 });
}
setTick(()=>{if(phase==='starting')boot();if(phase!=='stopped'&&phase!=='stopping')host.tick();});
async function stop(reason:string):Promise<void>{
 if(phase==='stopping'||phase==='stopped')return;phase='stopping';const start=performance.now();
 clearInterval(maintenance);host.stop();await service?.stop();
 const entries=[...sessions.values()];sessions.clear();pendingInitialize=0;await Promise.all(entries.map(closeSession));
 const server=httpServer;httpServer=null;
 for(const socket of sockets)socket.destroy();sockets.clear();
 if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));
 phase='stopped';report('stop',{reason,resourceEpoch:RESOURCE_EPOCH,sessionsClosed:entries.length,listenerReleased:true,elapsedMs:performance.now()-start});
}
on('onResourceStop',name=>{if(name===RESOURCE)void stop('resource-stop');});
RegisterCommand('fiveai_mcp_report',source=>{if(Number(source)===0)report('report',service?.status());},true);
report('load',{resource:RESOURCE,resourceEpoch:RESOURCE_EPOCH,build:__HTTP_MCP_BUILD__});
