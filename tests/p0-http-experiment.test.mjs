/**
 * P0 host-feasibility experiment: offline behaviour of the in-resource MCP
 * HTTP endpoint.
 *
 * This is NOT host acceptance. It runs the compiled experiment bundle under
 * the simulated FiveM runtime in ./helpers/fivem-host-shim.mjs, which is
 * enough to pin the parts that do not need a host: the HTTP boundary, the
 * session rules, the host-tick discipline and the stop/rebind path. Whether
 * FXServer itself accepts the SDK, the listener or the compiler is only
 * answerable on a real FXServer and stays NOT_EXECUTED here — see
 * packages/fivem-plugin/experiments/p0-http/README.md.
 *
 * The probe listens on the RFC-frozen default port 30130 unless
 * FIVEAI_P0_HTTP_PORT says otherwise. The suite takes an ephemeral port so it
 * never fights a server the operator already has running; the frozen defaults
 * themselves are asserted directly against the source of ./frozen.ts.
 */

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createFiveMHost } from "./helpers/fivem-host-shim.mjs";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const experimentDir = join(repoRoot, "packages", "fivem-plugin", "experiments", "p0-http");
const bundlePath = join(experimentDir, "dist", "server.js");

const { FROZEN, isAllowedHost, isAllowedOrigin, resolveHttpPort } = await import(
  new URL("../packages/fivem-plugin/experiments/p0-http/src/frozen.ts", import.meta.url).href
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
            text: Buffer.concat(chunks).toString("utf8"),
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

async function openSession(name = "p0-test") {
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

before(async () => {
  const build = spawnSync(process.execPath, [join(repoRoot, "packages", "fivem-plugin", "scripts", "build-p0-experiment.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(build.status, 0, `building the P0 experiment failed:\n${build.stdout}\n${build.stderr}`);

  port = await reserveFreePort();
  host = createFiveMHost({ bundlePath, env: { FIVEAI_P0_HTTP_PORT: String(port) } });
  await host.waitForLine("ready");
});

after(async () => {
  if (host === null) return;
  if (host.isRunning()) {
    const from = host.cursor();
    host.dispatchResourceStop();
    // Best effort only: whether the stop happens is asserted inside the tests,
    // teardown just must not leave a listener behind.
    await host.waitForLine("stop", { from, timeoutMs: 10_000 }).catch(() => undefined);
    await delay(50);
  }
  host.dispose();
});

test("the frozen RFC contract values are the ones the probe implements", () => {
  assert.equal(FROZEN.httpHost, "127.0.0.1");
  assert.equal(FROZEN.httpPort, 30130);
  assert.equal(FROZEN.httpPath, "/mcp");
  assert.equal(FROZEN.maxBodyBytes, 1024 * 1024);
  assert.equal(FROZEN.maxSessions, 32);
  // The port stays configurable (RFC §5) but only 1–65535 is accepted, and an
  // unusable value falls back to the fixed default rather than picking one.
  assert.equal(resolveHttpPort(undefined), 30130);
  assert.equal(resolveHttpPort("  "), 30130);
  assert.equal(resolveHttpPort("0"), 30130);
  assert.equal(resolveHttpPort("65536"), 30130);
  assert.equal(resolveHttpPort("30131"), 30131);
  // RFC §4.1: only the normalized loopback spellings, on the configured port.
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

test("the probe boots on loopback and reports its runtime capabilities", async () => {
  const capabilities = (await host.waitForLine("capabilities")).payload;
  assert.equal(capabilities.resource, "p0-http");
  assert.equal(typeof capabilities.resourceEpoch, "string");
  assert.equal(capabilities.listener.host, FROZEN.httpHost);
  assert.equal(capabilities.listener.port, port);
  assert.equal(capabilities.listener.path, FROZEN.httpPath);
  assert.equal(capabilities.compiler.module, "typescript");
  assert.match(capabilities.node.version, /^v22\./);
  // The SDK's Node transport converts through web-standard Request/Response,
  // so these are the APIs whose presence decides whether it can run at all.
  for (const api of ["Request", "Response", "Headers", "ReadableStream", "TextEncoder", "AbortController"]) {
    assert.equal(capabilities.webApis[api], true, `missing Web API in the probe runtime: ${api}`);
  }

  const workerProbe = (await host.waitForLine("worker-probe")).payload;
  assert.equal(typeof workerProbe.available, "boolean");
  assert.equal(workerProbe.available, true, `worker probe failed under plain Node: ${workerProbe.detail}`);
});

test("MCP initialize negotiates a session and lists exactly the probe tools", async () => {
  // Every request below goes out on its own TCP connection (`agent: false`),
  // so a session that survives from one request to the next also demonstrates
  // the RFC A02 rule that a single TCP close does not destroy a session.
  const session = await openSession();
  const listed = await rpc("tools/list", {}, { id: 2, session });
  assert.equal(listed.status, 200, listed.text);
  const parsed = JSON.parse(listed.text);
  assert.deepEqual(
    parsed.result.tools.map((tool) => tool.name).sort(),
    ["p0_compile_ts", "p0_native_read", "p0_status"],
  );

  const opened = host.evidence().filter((entry) => entry.tag === "session-open");
  assert.ok(opened.length >= 1, "an initialize must report a session-open line");

  const closed = await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
  assert.ok(closed.status === 200 || closed.status === 204, `DELETE: ${closed.status}`);

  const afterClose = await rpc("tools/list", {}, { id: 3, session });
  assert.equal(afterClose.status, 404, "a deleted session must not be reused");
});

test("tools/call crosses to the host tick for natives and stays off it otherwise", async () => {
  const session = await openSession("p0-tick");

  const before = JSON.parse((await callTool("p0_status", session)).text).result.structuredContent;
  const nativeRead = await callTool("p0_native_read", session);
  assert.equal(nativeRead.status, 200, nativeRead.text);
  const native = JSON.parse(nativeRead.text).result.structuredContent;
  assert.equal(native.executedOnHostTick, true);
  assert.equal(native.resource, "p0-http");
  assert.equal(native.resourceState, "started");
  assert.equal(typeof native.gameTimerMs, "number");

  const after = JSON.parse((await callTool("p0_status", session)).text).result.structuredContent;
  assert.equal(after.counters.tickDrains, before.counters.tickDrains + 1);
  // The whole point of the queue: a request handler never touched a native.
  assert.deepEqual(host.violations, []);

  const closed = await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
  assert.ok(closed.status === 200 || closed.status === 204, `DELETE: ${closed.status}`);
});

test("tools/call transpiles TypeScript in-process and reports the cost", async () => {
  const session = await openSession("p0-compile");
  const compiled = await callTool("p0_compile_ts", session);
  assert.equal(compiled.status, 200, compiled.text);
  const result = JSON.parse(compiled.text).result.structuredContent;
  assert.match(result.javascript, /function probe/);
  assert.ok(result.sourceBytes > 0);
  assert.ok(Number.isInteger(result.elapsedMs) && result.elapsedMs >= 0);

  const oversized = await callTool("p0_compile_ts", session, { source: "a".repeat(FROZEN.maxCodeBytes + 1) });
  const failure = JSON.parse(oversized.text).result;
  assert.equal(failure.isError, true);
  assert.equal(failure.structuredContent.error.code, "INVALID_ARGUMENT");

  const closed = await request({ method: "DELETE", headers: { [SESSION_HEADER]: session }, path: "/mcp" });
  assert.ok(closed.status === 200 || closed.status === 204, `DELETE: ${closed.status}`);
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
  assert.equal(wrongMethod.headers.allow, "POST, GET, DELETE");

  const getWithoutSession = await request({ method: "GET", headers: { accept: "text/event-stream" } });
  assert.equal(getWithoutSession.status, 400);
});

test("the transport refuses an illegal media type and an unsupported protocol version", async () => {
  const session = await openSession("p0-protocol");

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
  assert.ok(closed.status === 200 || closed.status === 204, `DELETE: ${closed.status}`);
});

test("a request body over the frozen 1 MiB ceiling is refused", async () => {
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
  const primes = [];
  let refusedAt = 0;
  let overLimit = { status: 0, headers: {}, text: "" };
  for (let attempt = 1; attempt <= FROZEN.maxSessions + 2; attempt += 1) {
    const response = await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: `p0-cap-${attempt}`, version: "0.0.1" },
    });
    if (response.status === 503) {
      refusedAt = attempt;
      overLimit = response;
      break;
    }
    assert.equal(response.status, 200, `initialize ${attempt} failed: ${response.text}`);
    primes.push(response.headers[SESSION_HEADER]);
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
    assert.ok(closed.status === 200 || closed.status === 204, `DELETE ${session}: ${closed.status}`);
  }
  const status = JSON.parse((await callTool("p0_status", await openSession("p0-cap-final"))).text);
  assert.equal(status.result.structuredContent.sessions.max, FROZEN.maxSessions);
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
    const session = await openSession(`p0-cycle-${cycle}`);
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
