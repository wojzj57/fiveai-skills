# P0 — in-resource MCP Streamable HTTP (host-feasibility probe)

A throwaway FiveM **server-only** resource that runs an MCP Streamable HTTP
endpoint inside FXServer and reports what the host actually supports.

Source of truth:

- `.notes/fivem-mcp-http/rfcs/fivem-resource-http-mcp-rfc.md` (§2, §4, §5, §10)
- `.notes/fivem-mcp-http/specs/fivem-mcp-http-migration-design.md` (§5, stage **P0**)

P0 is a **blocking technical verification, not a product slice**. Its exit
condition is a real FXServer run, so nothing in this folder has been accepted
on a host yet. The RFC-frozen technical values it implements (config v2 shape
and the §4.2 session parameters) were reviewed and frozen by the project owner
before this unit was written.

> This resource is **not** a delivery artifact. It is absent from the
> whitelist in `scripts/build-unified.mjs`, so `pnpm build` and `pnpm pack`
> can never ship it, and it is not part of `dist/fiveai-mcp`.

## Build

From the repository root:

```bash
pnpm build:p0          # esbuild: src/server.ts -> dist/server.js (Node 22 CJS)
pnpm typecheck:p0      # tsc --noEmit against the same source
```

`dist/` is gitignored; `dist/server.js` is the only file the manifest loads.

## Run it on a real host

1. Stop the resource before rebuilding. FxDK watches project files, and a
   watcher reading a half-written bundle produces misleading results.
2. Make the folder visible to your server — either copy it, or point a
   resource link at it:
   `D:\Exre\ex-fiveai\packages\fivem-plugin\experiments\p0-http`
3. Enable it in `server.cfg` (or in the FxDK project) and start it.
4. Read the server console. Every probe line is prefixed `FIVEAI_P0`.
5. Connect a real MCP client to `http://127.0.0.1:30130/mcp` and call the
   three probe tools.
6. Run `fiveai_p0_report` in the server console to dump the accumulated
   evidence as one JSON line.

The port defaults to the RFC-frozen `30130`. To deliberately exercise a
different port, set the `FIVEAI_P0_HTTP_PORT` environment variable for the
server process — there is no automatic fallback and no port scanning; a busy
port is reported and the resource stays `failed`.

## What to record

### 1. Node HTTP listener

| Evidence | Line |
| --- | --- |
| Bound and serving | `FIVEAI_P0 ready {"address":"http://127.0.0.1:30130/mcp",…}` |
| Listening had to happen on the host tick | `FIVEAI_P0 capabilities {…"listener":…}` |
| How long the resource takes to become useful | `FIVEAI_P0 ready {…,"bootElapsedMs":…}` |
| A busy port is reported, not worked around | `FIVEAI_P0 listen-error {"reason":"PORT_IN_USE","errno":"EADDRINUSE",…}` |

### 2. SDK transport and required Web APIs

`FIVEAI_P0 capabilities` reports, for the host runtime:

- `webApis` — `Request`, `Response`, `Headers`, `ReadableStream`,
  `WritableStream`, `TransformStream`, `TextEncoder`, `TextDecoder`,
  `AbortController`, `structuredClone`, `fetch`. The SDK's Node transport
  converts every request through `@hono/node-server` into a web-standard
  `Request`, so a `false` here is a hard blocker for this transport.
- `node.version` / `platform` / `arch` / `pid`.
- `compiler` — the bundled TypeScript compiler that loaded.

Then, from the client: `initialize` succeeds and the negotiated
`protocolVersion` is a 2025-family version (the probe asks for `2025-11-25`),
`tools/list` returns exactly `p0_status`, `p0_native_read`, `p0_compile_ts`.

### 3. Host-tick switching

`p0_native_read` returns `executedOnHostTick: true` with real native values
(`resource`, `resourceState`, `resourceCount`, `gameTimerMs`). Compare
`counters.tickDrains` before and after in `p0_status`.

The rule being verified: HTTP request handlers, socket data callbacks and MCP
request handlers run on the libuv thread and **must not** call natives; only
the `setTick` drain may. The offline shim enforces the same rule, so a
regression fails the test suite.

### 4. Stop cleanup

```text
FIVEAI_P0 stop {"reason":"resource-stop","sessionsClosed":N,"listenerReleased":true,"elapsedMs":…}
```

`listenerReleased` is not an assertion: the probe closes the listener, closes
every session and every socket, then binds and immediately releases the same
port to prove it is free.

**If this line never appears**, the host tore down the resource before the
cleanup finished. That is an RFC §5 blocker, not a cosmetic problem — say so
rather than reporting the stop as clean.

### 5. Isolated compilation

- `FIVEAI_P0 worker-probe {"available":true|false,"detail":…}` — whether
  `node:worker_threads` can start a worker in the resource at all.
- `p0_compile_ts` returns `javascript`, `sourceBytes` and `elapsedMs`. The
  elapsed time is how long a synchronous compile blocks the control path.

RFC §6.3 wants compilation moved into a host-side worker. If `available` is
`false`, the isolated-compilation requirement **cannot** be met as designed
and must go back for review — do not silently fall back to synchronous
compilation.

## Evidence table

Every row starts as **NOT_EXECUTED**. Fill it in from a real host run; do not
copy results from the offline suite.

| ID (RFC §9) | Check | Offline suite | Real FXServer |
| --- | --- | --- | --- |
| A01 | Strict config v2, migration rejection, port range, fixed host, unknown fields | NOT_APPLICABLE — the probe has no config file yet (P1) | NOT_EXECUTED |
| A02 | POST/GET/DELETE, illegal version/media type/session, Host/Origin rejection | PARTIAL — boundary, protocol-version, media-type and session rules covered; the GET SSE stream and reconnection are not | NOT_EXECUTED |
| H01 | Real FXServer loads the SDK and listens on 30130; MCP initialize and a read-only native call succeed | NOT_APPLICABLE | NOT_EXECUTED |
| H02 | 10 consecutive stop/start cycles, port released each time, no external MCP Node process | NOT_APPLICABLE | NOT_EXECUTED |
| H03 | Port occupied only reports an error; re-initialize after recovery | NOT_APPLICABLE | NOT_EXECUTED |

Record, for each host run: the FXServer/FxDK build, the client name and
version, the console lines above, and anything that did not behave as the RFC
predicts.

## What the offline suite covers — and what it does not

`tests/p0-http-experiment.test.mjs` builds this bundle and runs it under
`tests/helpers/fivem-host-shim.mjs`, a simulated FiveM runtime. It pins:

- the frozen contract constants, the Host/Origin allow-lists and the port
  parser;
- boot, capability reporting and the worker probe on plain Node;
- the full MCP handshake over loopback: `initialize`, `notifications/initialized`,
  `tools/list`, `tools/call`, `DELETE`;
- the HTTP boundary: foreign `Host`/`Origin`/`null` → 403, unknown path → 404,
  unknown method → 405, missing session → 400, unknown session → 404,
  over-limit body → 413, over-limit session → 503, illegal media type → 4xx,
  unsupported `MCP-Protocol-Version` → 400 without killing the session;
- that a session outlives the TCP connection that created it, and that each
  start mints a new resource epoch;
- host-tick discipline, by making every execution native throw when called off
  the tick;
- stop cleanup and repeated rebinds on the same port;
- that a busy port is reported as `PORT_IN_USE` and never worked around
  (no fallback port, no eviction, no stdio fallback).

It proves **nothing** about FXServer. Per RFC §2 and §10, a green offline run
is not host acceptance, and must not be reported as such.

## Notes for whoever continues this

- Config v2 is not read here at all. The probe takes the port from the
  environment and hardcodes the rest in `src/frozen.ts`; the delivered
  resource reads `mcp/config.json` through `LoadResourceFile` on a host tick
  (RFC §5).
- The probe uses `enableJsonResponse: true` so a POST answers with JSON rather
  than a request-scoped SSE stream, matching RFC §4.1 ("POST carries
  JSON-RPC; GET provides SSE").
- Host/Origin validation lives in the probe's own HTTP layer. SDK 1.30.0 marks
  its `allowedHosts`/`allowedOrigins` options deprecated in favour of external
  middleware, so the delivered `src/http/` owns this check (RFC §3, §4.1).
- The tool set is deliberately three probe tools, not the RFC §6.1 catalog,
  and the results carry no strict output schemas. Both belong to P1.
