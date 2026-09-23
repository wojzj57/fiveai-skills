/**
 * Offline behaviour of the formal in-resource HTTP MCP.
 * HTTP endpoint.
 *
 * This is NOT host acceptance. It runs the compiled resource bundle under
 * the simulated FiveM runtime in ./helpers/fivem-host-shim.mjs, which is
 * enough to pin the parts that do not need a host: the HTTP boundary, the
 * session rules, the host-tick discipline and the stop/rebind path. Whether
 * FXServer itself accepts the SDK, the listener or the executor is only
 * answerable on a real FXServer and stays NOT_EXECUTED here — see
 * fivem-mcp/http-mcp/README.md.
 *
 * The probe listens on the RFC-frozen default port 30130 unless
 * config/config.json overrides it. The suite takes an ephemeral port so it
 * never fights a server the operator already has running; the frozen defaults
 * themselves are asserted directly against the source of ./frozen.ts.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFiveMHost } from "./helpers/fivem-host-shim.mjs";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
/**
 * The suite builds into a throwaway directory (RFC §12: "测试只能使用临时
 * fixture 输出，不能运行默认 build 覆盖已挂载目录"). The default output
 * `fivem-mcp/artificials/fivem-mcp` is what an operator links into FxDK, so a
 * test must never replace it.
 */
let buildRoot = null;
let bundlePath = null;

const { FROZEN, isAllowedHost, isAllowedOrigin } = await import(
  new URL("../../fivem-mcp/http-mcp/src/frozen.ts", import.meta.url).href
);

const PROTOCOL_VERSION = "2025-11-25";
const SESSION_HEADER = "mcp-session-id";

let host = null;
let port = 0;

/** Reserve an ephemeral loopback port, then release it for the probe to take. */
function reserveFreePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const chosen = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(chosen));
    });
  });
}

/**
 * One raw request, so Host/Origin/method can be set without fetch restrictions.
 * `hostHeader` needs both `setHost: false` (stop Node adding its own Host) and
 * the explicit header: Node's server answers a missing Host with its own 400
 * before the probe ever sees it, which would mask the probe's 403.
 */
function request({ method = "POST", path = "/mcp", headers = {}, body, hostHeader }) {
  const finalHeaders = hostHeader === undefined ? headers : { ...headers, host: hostHeader };
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: finalHeaders,
        agent: false,
        setHost: hostHeader === undefined,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: res.headers['content-type']?.includes('text/event-stream') ? Buffer.concat(chunks).toString('utf8').split('\n').filter(line=>line.startsWith('data: ')).at(-1)?.slice(6)??'' : Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rpc(method, params, { id = 1, session, extraHeaders } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (session !== undefined) headers[SESSION_HEADER] = session;
  return request({ headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

function notify(method, params, { session } = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (session !== undefined) headers[SESSION_HEADER] = session;
  return request({ headers, body: JSON.stringify({ jsonrpc: "2.0", method, params }) });
}

async function openSession(name = "http-test") {
  const response = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name, version: "0.0.1" },
  });
  assert.equal(response.status, 200, `initialize failed: ${response.text}`);
  const session = response.headers[SESSION_HEADER];
  assert.equal(typeof session, "string", "initialize must return a session id");
  const accepted = await notify("notifications/initialized", {}, { session });
  assert.ok(accepted.status === 202 || accepted.status === 200, `initialized notify: ${accepted.status}`);
  return session;
}

function callTool(name, session, args = {}) {
  return rpc("tools/call", { name, arguments: args }, { id: 9, session });
}

/** JSON-RPC error code of a protocol-level refusal. */
function rpcErrorCode(response) {
  return JSON.parse(response.text).error?.code;
}

/**
 * A deliberately incomplete request: announce a body, send part of it, then
 * stop without ending or destroying the socket.
 */
function rawRequest({ declaredLength, body }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "content-length": String(declaredLength),
        },
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.write(body);
    // Intentionally never end(): the read budget must expire instead.
  });
}

before(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), "fiveai-http-mcp-suite-"));
  const artifact = join(buildRoot, "fivem-mcp");
  const build = spawnSync(
    process.execPath,
    [join(repoRoot, "fivem-mcp", "scripts", "build-http-mcp.mjs"), "--out", artifact],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert.equal(build.status, 0, `building the HTTP MCP resource failed:\n${build.stdout}\n${build.stderr}`);
  bundlePath = join(artifact, "dist", "server.js");

  port = await reserveFreePort();
  // `resourcePath` is what GetResourcePath answers: the resource resolves
  // resource-owned configuration from it, exactly as it does on a real host.
  await writeFile(join(artifact,"config","config.json"),JSON.stringify({port}));
  host = createFiveMHost({ bundlePath, resourcePath: artifact });
  await host.waitForLine("ready");
});

after(async () => {
  if (host !== null) {
    // A host always stops the resource before the process ends, so the stop path
    // runs even when the last state was `failed` (a busy port) — otherwise a
    // worker thread would outlive the suite and the process could not exit.
    const from = host.cursor();
    host.dispatchResourceStop();
    await host.waitForLine("stop", { from, timeoutMs: 10_000 }).catch(() => undefined);
    await delay(50);
    host.dispose();
  }
  if (buildRoot !== null) await rm(buildRoot, { recursive: true, force: true });
});

test("the transport contract values are the ones the probe implements", () => {
  assert.equal(FROZEN.httpHost, "127.0.0.1");
  assert.equal(FROZEN.httpPort, 30130);
  assert.equal(FROZEN.httpPath, "/mcp");
  // RFC §3: 256KiB body, 8 concurrent sessions, port domain 1024–65535 and a
  // 5s body-read budget; §4: one protocol version.
  assert.equal(FROZEN.maxBodyBytes, 256 * 1024);
  assert.equal(FROZEN.maxSessions, 8);
  assert.equal(FROZEN.maxBodyReadMs, 5000);
  assert.equal(FROZEN.minHttpPort, 1024);
  assert.equal(FROZEN.protocolVersion, "2025-11-25");
  // The port stays configurable but only inside the contract domain; an
  // unusable value falls back to the fixed default rather than picking one.
  // RFC §4: only the normalized loopback spellings, on the configured port.
  assert.equal(isAllowedHost("127.0.0.1:30130", 30130), true);
  assert.equal(isAllowedHost("localhost:30130", 30130), true);
  assert.equal(isAllowedHost(undefined, 30130), false);
  assert.equal(isAllowedHost("evil.example:30130", 30130), false);
  assert.equal(isAllowedHost("127.0.0.1:30131", 30130), false);
  assert.equal(isAllowedOrigin(undefined, 30130), true);
  assert.equal(isAllowedOrigin("http://localhost:30130", 30130), true);
  assert.equal(isAllowedOrigin("null", 30130), false);
  assert.equal(isAllowedOrigin("http://evil.example", 30130), false);
});

test("MCP initialize negotiates a session and lists formal tools with no probes", async () => {
  // Every request below goes out on its own TCP connection (`agent: false`),
  // so a session that survives from one request to the next also demonstrates
  // the RFC A02 rule that a single TCP close does not destroy a session.
  const session = await openSession();
  const listed = await rpc("tools/list", {}, { id: 2, session });
  assert.equal(listed.status, 200, listed.text);
  const parsed = JSON.parse(listed.text);
  assert.deepEqual(
    parsed.result.tools.map((tool) => tool.name).sort(),
    ["execute_js", "execute_lua", "logs", "queue", "reference", "resource", "status"],
  );

  const opened = host.evidence().filter((entry) => entry.tag === "session-open");
  assert.ok(opened.length >= 1, "an initialize must report a session-open line");

  // A GET on a live session must be refused too: the refusal is about the
  // method, not about the session.
  const sse = await request({ method: "GET", headers: { accept: "text/event-stream", [SESSION_HEADER]: session } });
  assert.equal(sse.status, 405, `a live-session GET must be 405, got ${sse.status}`);
  assert.equal(sse.headers.allow, "POST, DELETE");

  const closed = await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
  assert.equal(closed.status, 204, `DELETE must answer the contract value 204, got ${closed.status}`);

  const afterClose = await rpc("tools/list", {}, { id: 3, session });
  assert.equal(afterClose.status, 404, "a deleted session must not be reused");
});

test('tool discovery follows installed resources and reports partial availability',async()=>{
  const session=await openSession('discovery');
  try{
    const initial=JSON.parse((await rpc('tools/list',{}, {id:701,session})).text).result.tools;
    assert.equal(initial.length,7);
    assert.match(initial.find(t=>t.name==='execute_js').description,/Client execution unavailable/);
    assert.match(initial.find(t=>t.name==='logs').description,/Client logs unavailable/);
    assert.equal(rpcErrorCode(await callTool('esx',session,{})),-32602);
    const noClient=JSON.parse((await callTool('logs',session,{})).text).result.structuredContent;
    assert.equal(noClient.error.code,'TARGET_UNAVAILABLE');
    const server=JSON.parse((await callTool('logs',session,{side:'server'})).text).result.structuredContent;
    assert.equal(server.ok,true);
    host.setDependency('es_extended','1.15.2',{});
    host.setDependency('ox_lib','3.39.0',{});
    host.setDependency('ox_target','0.0.0',{});
    host.setResourceState('ox_lib','stopped');
    const listed=JSON.parse((await rpc('tools/list',{}, {id:702,session})).text).result.tools;
    assert.deepEqual(listed.map(t=>t.name).sort(),['esx','execute_js','execute_lua','logs','ox','queue','reference','resource','status']);
    assert.match(listed.find(t=>t.name==='ox').description,/ox_lib: unavailable.*stopped/);
    assert.match(listed.find(t=>t.name==='ox').description,/ox_target: unavailable.*requires 1.18.1/);
    assert.doesNotMatch(listed.find(t=>t.name==='ox').description,/oxmysql:/);
    assert.match(listed.find(t=>t.name==='esx').description,/available/);
    host.setResourceState('es_extended','stopped');
    const stopped=JSON.parse((await rpc('tools/list',{}, {id:703,session})).text).result.tools;
    assert.match(stopped.find(t=>t.name==='esx').description,/unavailable.*stopped/);
    const stoppedCall=JSON.parse((await callTool('esx',session,{side:'server',scope:'framework',method:'GetPlayerFromId',args:[7]})).text).result.structuredContent;
    assert.equal(stoppedCall.error.code,'DEPENDENCY_MISSING');
    const missingLibrary=JSON.parse((await callTool('ox',session,{side:'server',library:'oxmysql',method:'query',args:['SELECT 1']})).text).result.structuredContent;
    assert.equal(missingLibrary.error.code,'DEPENDENCY_MISSING');
    host.setResourceState('es_extended',null);
    assert.equal(rpcErrorCode(await callTool('esx',session,{})),-32602);
    const removed=JSON.parse((await rpc('tools/list',{}, {id:704,session})).text).result.tools;
    assert.equal(removed.some(t=>t.name==='esx'),false);
    assert.deepEqual(host.violations,[]);
  }finally{
    host.setResourceState('es_extended',null);
    host.setResourceState('ox_lib',null);
    host.setResourceState('ox_target',null);
    await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
  }
});

test("tools are refused until the session sends notifications/initialized", async () => {
  const response = await rpc("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "http-preinit", version: "0.0.1" },
  });
  assert.equal(response.status, 200, response.text);
  const session = response.headers[SESSION_HEADER];
  assert.equal(typeof session, "string");

  // RFC §4: "未收到 initialized 通知不能执行工具". The SDK does not enforce it.
  const early = await callTool("status", session);
  assert.equal(early.status, 400, `tools/call before initialized: ${early.status} ${early.text}`);
  assert.equal(JSON.parse(early.text).error.code, -32600);

  const malformed=await request({headers:{'content-type':'application/json',accept:'application/json, text/event-stream',[SESSION_HEADER]:session},body:JSON.stringify({method:'notifications/initialized'})});
  assert.equal(malformed.status,400);assert.equal((await callTool('status',session)).status,400);
  const accepted = await notify("notifications/initialized", {}, { session });
  assert.ok(accepted.status === 202 || accepted.status === 200, `initialized notify: ${accepted.status}`);

  const after = await callTool("status", session);
  assert.equal(after.status, 200, `tools/call after initialized: ${after.text}`);

  await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
});

test('initialize batches and empty reference queries are protocol errors',async()=>{
 const batch=await request({headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'batch',version:'1'}}}])});
 assert.equal(batch.status,400);assert.equal(batch.headers[SESSION_HEADER],undefined);
 const session=await openSession('reference-empty');const empty=await callTool('reference',session,{query:'   '});assert.equal(rpcErrorCode(empty),-32602);
 await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
});

test("initialize pins the single supported protocol version", async () => {
  // RFC §4: this release speaks 2025-11-25 only; an initialize asking for
  // another version is answered with the version this end supports, and the
  // client decides whether to continue. The SDK would otherwise echo a version
  // from its own older, wider list.
  const response = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "http-version-pin", version: "0.0.1" },
  });
  assert.equal(response.status, 200, response.text);
  const body = JSON.parse(response.text);
  assert.equal(body.result.protocolVersion, PROTOCOL_VERSION);
  // Only the tools capability is declared, and it never changes.
  assert.equal(body.result.capabilities.tools.listChanged, false);
  const pinned = host.evidence().some(
    (entry) => entry.tag === "protocol-version-pinned" && entry.payload.requested === "2025-06-18",
  );
  assert.equal(pinned, true, "the pinned request must be reported, not silently rewritten");

  const session = response.headers[SESSION_HEADER];
  await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
});

test("the protocol lock also holds on the request header, not only on initialize", async () => {
  const session = await openSession("http-version-header");

  // The SDK's own supported list still holds 2025-06-18 / 2025-03-26 /
  // 2024-11-05 / 2024-10-07 and would answer 200 for them. §4 requires 400 for
  // a header that is explicitly incompatible with the locked version.
  for (const version of ["2025-06-18", "2025-03-26", "2024-10-07", "1999-01-01"]) {
    const refused = await rpc("tools/list", {}, {
      id: 40,
      session,
      extraHeaders: { "mcp-protocol-version": version },
    });
    assert.equal(refused.status, 400, `${version} must be refused: ${refused.text}`);
    assert.equal(rpcErrorCode(refused), -32600, refused.text);
  }

  // No header: the session's negotiated version governs, so the request works.
  const withoutHeader = await rpc("tools/list", {}, { id: 41, session });
  assert.equal(withoutHeader.status, 200, withoutHeader.text);

  // The locked version itself is accepted.
  const matching = await rpc("tools/list", {}, {
    id: 42,
    session,
    extraHeaders: { "mcp-protocol-version": PROTOCOL_VERSION },
  });
  assert.equal(matching.status, 200, matching.text);

  // A refusal must not have damaged the session.
  const stillUsable = await rpc("tools/list", {}, { id: 43, session });
  assert.equal(stillUsable.status, 200);

  await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
});

test("an unknown tool is a JSON-RPC -32602, not a tool error wrapper", async () => {
  const session = await openSession("http-unknown-tool");
  const response = await callTool("does_not_exist", session, {});
  assert.equal(rpcErrorCode(response), -32602, response.text);
  // The status is uniform with this end point's other protocol errors; the SDK
  // would otherwise answer 200 with an error body.
  assert.equal(response.status, 400, `unknown tool must be 400, got ${response.status}`);
  await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
});

test("a malformed body and a missing session are JSON-RPC protocol errors", async () => {
  const malformed = await request({
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: "{ not json",
  });
  assert.equal(malformed.status, 400);
  assert.equal(JSON.parse(malformed.text).error.code, -32700);

  const noSession = await rpc("tools/list", {}, { id: 20 });
  assert.equal(noSession.status, 400);
  assert.equal(JSON.parse(noSession.text).error.code, -32600);

  const unknownSession = await rpc("tools/list", {}, { id: 21, session: "00000000-0000-4000-8000-000000000000" });
  assert.equal(unknownSession.status, 404);
  assert.equal(JSON.parse(unknownSession.text).error.code, -32600);
});

test("a stalled request body hits the read budget with 408", { timeout: 30_000 }, async () => {
  // §3 gives the body read a 5s budget. Without it a client that announces a
  // body and then stops holds the request open forever.
  const started = Date.now();
  const response = await rawRequest({ declaredLength: 50, body: "x" });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 408, `expected 408, got ${response.status}: ${response.text}`);
  assert.equal(response.headers.connection, "close");
  assert.ok(elapsed >= 4_000, `the budget must actually be waited out, took ${elapsed}ms`);
});

test("the HTTP boundary rejects a foreign Host, a foreign Origin, unknown paths and unknown methods", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  const foreignHost = await request({ headers, body, hostHeader: "evil.example" });
  assert.equal(foreignHost.status, 403);

  const foreignOrigin = await request({ headers: { ...headers, origin: "http://evil.example" }, body });
  assert.equal(foreignOrigin.status, 403);

  const nullOrigin = await request({ headers: { ...headers, origin: "null" }, body });
  assert.equal(nullOrigin.status, 403);

  // 400 here is the routing answer ("a session id is required"): the request
  // got past the origin gate, which is the only thing this line checks.
  const allowedOrigin = await request({ headers: { ...headers, origin: `http://127.0.0.1:${port}` }, body });
  assert.equal(allowedOrigin.status, 400, "the loopback origin must be accepted");

  const wrongPath = await request({ path: "/other", headers, body });
  assert.equal(wrongPath.status, 404);

  const wrongMethod = await request({ method: "PUT", headers, body });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, "POST, DELETE");

  // RFC §4: GET is not served at all — no standalone subscription, and no
  // Last-Event-ID replay, because every elicitation travels on the original
  // tools/call POST. Advertising GET in `allow` would invite clients onto it.
  const getWithoutSession = await request({ method: "GET", headers: { accept: "text/event-stream" } });
  assert.equal(getWithoutSession.status, 405);
});

test("the transport refuses an illegal media type and an unsupported protocol version", async () => {
  const session = await openSession("http-protocol");

  const wrongMediaType = await request({
    headers: { "content-type": "text/plain", accept: "application/json, text/event-stream", [SESSION_HEADER]: session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "tools/list", params: {} }),
  });
  assert.ok(
    wrongMediaType.status >= 400 && wrongMediaType.status < 500,
    `an illegal media type must be a 4xx, got ${wrongMediaType.status}: ${wrongMediaType.text}`,
  );

  const wrongVersion = await rpc("tools/list", {}, {
    id: 11,
    session,
    extraHeaders: { "mcp-protocol-version": "1999-01-01" },
  });
  assert.equal(wrongVersion.status, 400, `an unsupported protocol version must be refused: ${wrongVersion.text}`);

  // Neither refusal may have damaged the session: the negotiated version is
  // still usable, which is what makes "reject the request" different from
  // "kill the session".
  const stillUsable = await rpc("tools/list", {}, { id: 12, session });
  assert.equal(stillUsable.status, 200);

  const closed = await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
  assert.equal(closed.status, 204, `DELETE must answer the contract value 204, got ${closed.status}`);
});

test("a request body over the frozen 256KiB ceiling is refused", async () => {
  const oversized = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { padding: "x".repeat(FROZEN.maxBodyBytes) },
  });
  assert.ok(Buffer.byteLength(oversized) > FROZEN.maxBodyBytes);
  const response = await request({
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: oversized,
  });
  assert.equal(response.status, 413);
});

test("a session is required after initialize, and an unknown session is refused", async () => {
  const withoutSession = await rpc("tools/list", {}, { id: 4 });
  assert.equal(withoutSession.status, 400);

  const unknownSession = await rpc("tools/list", {}, { id: 5, session: "00000000-0000-4000-8000-000000000000" });
  assert.equal(unknownSession.status, 404);
});

test("the session ceiling refuses an over-limit initialize without evicting live sessions", async () => {
  // The ceiling counts live sessions, so one leaked by an earlier test would
  // show up here as fewer admissions rather than as a failure. Assert the floor.
  const floorSession = await openSession("http-cap-floor");
  const floorStatus = JSON.parse((await callTool("status", floorSession)).text).result.structuredContent;
  assert.equal(host.evidence().filter(e=>e.tag==="session-open").at(-1).payload.active, 1, "a previous test leaked a session");
  await request({ method: "DELETE", headers: { [SESSION_HEADER]: floorSession }, path: "/mcp" });

  const primes = [];
  let refusedAt = 0;
  let overLimit = { status: 0, headers: {}, text: "" };
  for (let attempt = 1; attempt <= FROZEN.maxSessions + 2; attempt += 1) {
    const response = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `http-cap-${attempt}`, version: "0.0.1" },
    });
    // §3 gives 429 to the concurrency ceiling; 503 belongs to the inbound
    // connection budget, which this entry point does not track.
    if (response.status === 429) {
      refusedAt = attempt;
      overLimit = response;
      break;
    }
    assert.equal(response.status, 200, `initialize ${attempt} failed: ${response.text}`);
    const session = response.headers[SESSION_HEADER];
    await notify("notifications/initialized", {}, { session });
    primes.push(session);
  }

  // Exactly the configured number is admitted, so no earlier test leaked a
  // session and the refused attempt did not displace anything.
  assert.equal(primes.length, FROZEN.maxSessions);
  assert.equal(refusedAt, FROZEN.maxSessions + 1, "an over-limit initialize must be refused, not queued");
  assert.equal(overLimit.headers[SESSION_HEADER], undefined);

  // Refusal must not have evicted anything: the oldest session still answers.
  const oldest = await rpc("tools/list", {}, { id: 6, session: primes[0] });
  assert.equal(oldest.status, 200);

  for (const session of primes) {
    const closed = await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
    assert.equal(closed.status, 204, `DELETE ${session} must answer 204, got ${closed.status}`);
  }
  const status = JSON.parse((await callTool("status", await openSession("http-cap-final"))).text);
  assert.equal(status.result.structuredContent.data.service,"fivem-mcp");
});

test('native JS executes through the FIFO and task query preserves encoded values', async()=>{
 const session=await openSession();
 const reply=await rpc('tools/call',{name:'execute_js',arguments:{side:'server',code:'const n = args.value; return n + GetNumResources();',args:{value:39}}},{session,id:101});
 const body=JSON.parse(reply.text).result;assert.equal(body.isError,false,reply.text);assert.equal(body.structuredContent.data.state,'succeeded');assert.deepEqual(body.structuredContent.data.result,{kind:'values',values:[42]});
 const id=body.structuredContent.data.taskId;
 const query=await rpc('tools/call',{name:'queue',arguments:{action:'status',taskId:id}},{session,id:102});
 assert.equal(JSON.parse(query.text).result.structuredContent.data.task.taskId,id);
 const old=await rpc('tools/call',{name:'execute_ts',arguments:{side:'server',code:'return 1;'}},{session,id:110});
 assert.equal(JSON.parse(old.text).error.code,-32602);
 const typed=await rpc('tools/call',{name:'execute_js',arguments:{side:'server',code:'const n: number=1;return n;'}},{session,id:111});
 assert.equal(JSON.parse(typed.text).result.structuredContent.error.code,'JAVASCRIPT_INVALID');
 const asyncNative=await rpc('tools/call',{name:'execute_js',arguments:{side:'server',code:'await Promise.resolve(); return await mcp.host(() => GetNumResources());'}},{session,id:112});
 assert.equal(JSON.parse(asyncNative.text).result.structuredContent.data.state,'succeeded');
 const bad=await rpc('tools/call',{name:'execute_js',arguments:{side:'server',code:'return require("x");'}},{session,id:103});
 assert.equal(JSON.parse(bad.text).result.structuredContent.error.code,'JAVASCRIPT_INVALID');
 await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
});

test('server logs include the host console history from before MCP startup',async()=>{
 const session=await openSession();
 const result=JSON.parse((await callTool('logs',session,{side:'server',contains:'server history before MCP'})).text).result.structuredContent;
 assert.equal(result.data.lines.length,1);
 assert.equal(result.data.lines[0].message,'server history before MCP');
});

test('resource changes share FIFO and server logs preserve resource attribution',async()=>{
 const session=await openSession();
 const list=await callTool('resource',session,{action:'list'});assert.equal(JSON.parse(list.text).result.structuredContent.data.resources.length,3);
 const protectedResult=await callTool('resource',session,{action:'stop',name:'fivem-mcp'});assert.equal(JSON.parse(protectedResult.text).result.structuredContent.error.code,'SELF_RESOURCE_PROTECTED');
 const started=await callTool('resource',session,{action:'start',name:'example'});assert.equal(JSON.parse(started.text).result.structuredContent.data.result.change.after,'started');
 host.log('script:example','hello resource');
 const logs=await callTool('logs',session,{side:'server',resource:'example'});assert.equal(JSON.parse(logs.text).result.structuredContent.data.lines[0].message,'hello resource');
 await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
});

test('server Lua local terminal uses its server identity rather than the client wire envelope',async()=>{
 const session=await openSession('lua-bridge');let executions=0;
 host.onLocal('fivem-mcp:mcp:v1:local:execute',raw=>{const message=JSON.parse(raw);executions++;assert.equal(message.payload.kind,'lua');host.local('fivem-mcp:mcp:v1:local:terminal',JSON.stringify({v:1,type:'terminal',binding:message.binding,taskId:message.taskId,payload:{execution:'ended',result:{kind:'values',values:[42,{$mcp:'nil'}]}}}));});
 const result=JSON.parse((await callTool('execute_lua',session,{side:'server',code:'return 42, nil'})).text).result.structuredContent;
 assert.equal(result.ok,true,JSON.stringify(result));assert.equal(executions,1);assert.deepEqual(result.data.result.values,[42,{$mcp:'nil'}]);
 await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
});

test('HTTP client execution binds the genuine network source and settles matching terminal evidence',async()=>{
  const session=await openSession('client-integration');
  const epoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';let binding,marker;
  host.onNetwork((event,id,raw)=>{
    const message=JSON.parse(raw);assert.equal(id,7);
    if(event.endsWith(':bind')){binding=message.binding;marker=`FIVEM_MCP_BIND:${binding.resourceEpoch}:${binding.connectionId}:${binding.clientEpoch}:${message.payload.logMarker}`;host.networkFrom(7,'fivem-mcp:mcp:v1:heartbeat',JSON.stringify({v:1,type:'heartbeat',binding,payload:{lua:true,js:true}}));}
    if(event.endsWith(':execute')){host.networkFrom(7,'fivem-mcp:mcp:v1:terminal',JSON.stringify({v:1,type:'terminal',binding,taskId:message.taskId,payload:{execution:'ended',result:{kind:'values',values:[42]}}}));}
  });
  host.networkFrom(7,'fivem-mcp:mcp:v1:hello',JSON.stringify({v:1,type:'hello',payload:{clientEpoch:epoch,lua:true,js:true}}));
  await delay(20);
  const result=JSON.parse((await callTool('execute_js',session,{side:'client',clientId:7,code:'return 42;'})).text).result.structuredContent;
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(result.data.target.binding.clientId,7);assert.deepEqual(result.data.result.values,[42]);
  const status=JSON.parse((await callTool('status',session,{clientId:7})).text).result.structuredContent;
  assert.equal(status.ok,true,JSON.stringify(status));assert.equal(status.data.clients.length,1);
  const defaultLogs=JSON.parse((await callTool('logs',session,{})).text).result.structuredContent;
  assert.equal(defaultLogs.error.code,'LOG_SOURCE_UNAVAILABLE');
  const allLogs=JSON.parse((await callTool('logs',session,{side:'all'})).text).result.structuredContent;
  assert.equal(allLogs.ok,true);assert.equal(allLogs.data.coverage.length,2);
  assert.equal(allLogs.data.coverage[1].clientId,7);
  const line='[  1] [fxdk_b3258_Gam] MainThrd/ [exnui] bridge line';
  const batch={marker,fileId:'CitizenFX_current.log',startOffset:100,endOffset:100+Buffer.byteLength(line+'\n'),lines:[line]};
  const refused=await request({path:'/mcp/client-logs',headers:{'content-type':'application/json'},body:JSON.stringify({...batch,marker:'wrong'})});
  assert.equal(refused.status,409);
  const accepted=await request({path:'/mcp/client-logs',headers:{'content-type':'application/json'},body:JSON.stringify(batch)});
  assert.equal(accepted.status,200,accepted.text);
  const duplicate=await request({path:'/mcp/client-logs',headers:{'content-type':'application/json'},body:JSON.stringify(batch)});
  assert.equal(duplicate.status,200);
  const clientLogs=JSON.parse((await callTool('logs',session,{side:'client',resource:'exnui'})).text).result.structuredContent;
  assert.equal(clientLogs.ok,true,JSON.stringify(clientLogs));
  assert.deepEqual(clientLogs.data.lines.map(entry=>entry.message),['bridge line']);
  host.onNetwork((event,id,raw)=>{const message=JSON.parse(raw);if(event.endsWith(':bind'))host.networkFrom(id,'fivem-mcp:mcp:v1:heartbeat',JSON.stringify({v:1,type:'heartbeat',binding:message.binding,payload:{lua:true,js:true}}));});
  host.networkFrom(8,'fivem-mcp:mcp:v1:hello',JSON.stringify({v:1,type:'hello',payload:{clientEpoch:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',lua:true,js:true}}));await delay(20);
  const multiList=JSON.parse((await rpc('tools/list',{}, {id:705,session})).text).result.tools;
  assert.match(multiList.find(t=>t.name==='logs').description,/Specify clientId/);
  assert.equal(rpcErrorCode(await callTool('logs',session,{side:'all'})),-32602);
  assert.equal(rpcErrorCode(await callTool('logs',session,{})),-32602);
  const selected=JSON.parse((await callTool('logs',session,{side:'all',clientId:7})).text).result.structuredContent;
  assert.equal(selected.ok,true,JSON.stringify(selected));assert.equal(selected.data.coverage.length,2);
  assert.equal(selected.data.coverage[1].clientId,7);
  host.onNetwork(null);await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
});

test('SQL writes require form elicitation on the original SSE stream before FIFO dispatch',async()=>{
  let writes=0;host.setDependency('oxmysql','2.14.1',{update_async:async(sql,values)=>{writes++;assert.equal(sql,'UPDATE fixture SET enabled = ?');assert.deepEqual(values,[true]);return 1;}});
  const init=await rpc('initialize',{protocolVersion:PROTOCOL_VERSION,capabilities:{elicitation:{form:{}}},clientInfo:{name:'approval-test',version:'1'}});
  const session=init.headers[SESSION_HEADER];await notify('notifications/initialized',{}, {session});
  async function write(approve){
    return await new Promise((resolve,reject)=>{
      const req=httpRequest({host:'127.0.0.1',port,path:'/mcp',method:'POST',agent:false,headers:{'content-type':'application/json',accept:'application/json, text/event-stream',[SESSION_HEADER]:session}},res=>{
        assert.match(res.headers['content-type'],/text\/event-stream/);let pending='';
        res.on('data',chunk=>{pending+=chunk.toString();let end;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)continue;const message=JSON.parse(data.slice(6));
          if(message.method==='elicitation/create'){
            assert.equal(writes,0);assert.ok(message.params.message.includes('UPDATE fixture SET enabled = ?'));
            void request({headers:{'content-type':'application/json',accept:'application/json, text/event-stream',[SESSION_HEADER]:session},body:JSON.stringify({jsonrpc:'2.0',id:message.id,result:{action:'accept',content:{approve}}})}).catch(reject);
          }else if(message.id===91)resolve(message.result.structuredContent);
        }});res.on('error',reject);
      });req.on('error',reject);req.end(JSON.stringify({jsonrpc:'2.0',id:91,method:'tools/call',params:{name:'ox',arguments:{side:'server',library:'oxmysql',method:'update',args:['UPDATE fixture SET enabled = ?',[true]]}}}));
    });
  }
  const declined=await write(false);assert.equal(declined.error.code,'CONFIRMATION_DECLINED');assert.equal(writes,0);
  const accepted=await write(true);assert.equal(accepted.ok,true,JSON.stringify(accepted));assert.equal(writes,1);assert.deepEqual(accepted.data.result.values,[1]);
  await request({method:'DELETE',headers:{[SESSION_HEADER]:session}});
});

test("stopping releases the listener and the port rebinds across restarts", async () => {
  const stopFrom = host.cursor();
  host.dispatchResourceStop();
  const stopped = (await host.waitForLine("stop", { from: stopFrom })).payload;
  assert.equal(stopped.reason, "resource-stop");
  assert.equal(stopped.listenerReleased, true, "onResourceStop must release the port, not just stop answering");

  await assertPortIsFree();

  const firstEpoch = host.evidence().find((entry) => entry.tag === "ready").payload.resourceEpoch;
  assert.equal(typeof firstEpoch, "string");

  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const from = await host.restart();
    const ready = host.evidence(from).find((entry) => entry.tag === "ready");
    // A fresh run must mint a new epoch: RFC §4.2 makes the epoch the only
    // thing that invalidates a previous run's sessions and tasks.
    assert.equal(typeof ready.payload.resourceEpoch, "string");
    assert.notEqual(ready.payload.resourceEpoch, firstEpoch, `cycle ${cycle} reused a resource epoch`);
    const session = await openSession(`http-cycle-${cycle}`);
    const listed = await rpc("tools/list", {}, { id: 7, session });
    assert.equal(listed.status, 200, `cycle ${cycle} must serve tools after a rebind`);

    const stopFromCycle = host.cursor();
    host.dispatchResourceStop();
    const cycleStop = (await host.waitForLine("stop", { from: stopFromCycle })).payload;
    assert.equal(cycleStop.listenerReleased, true, `cycle ${cycle} must release the port`);
  }
  assert.deepEqual(host.violations, []);
});

test("a busy port is reported and never worked around", async () => {
  // RFC §5: the port is an explicit setting, so a collision is an error. There
  // is no fallback port, no evicting the other process, and no stdio fallback.
  const blocker = createServer();
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(port, "127.0.0.1", resolve);
  });
  try {
    const from = host.reload();
    const failure = (await host.waitForLine("listen-error", { from })).payload;
    assert.equal(failure.reason, "PORT_IN_USE");
    assert.equal(failure.errno, "EADDRINUSE");
    assert.equal(
      host.evidence(from).some((entry) => entry.tag === "ready"),
      false,
      "a failed bind must not be followed by a ready line",
    );
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
});

function assertPortIsFree() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => reject(new Error(`the port was not released: ${error.message}`)));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}
