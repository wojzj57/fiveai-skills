# FiveAI FiveM HTTP MCP

A single resource serves Streamable HTTP MCP at `http://127.0.0.1:30130/mcp`.
JavaScript snippets execute natively. No runtime TypeScript compiler, external
broker or compilation Worker is required. TypeScript remains a build-time tool.

Real FxDK/FXServer, two-client, framework/database and AI application acceptance
remain **NOT_EXECUTED**. Node shims and Lua 5.4 tests are not FiveM acceptance.

## Build and install

From the repository root with dependencies installed:

```powershell
npm ci
cd fivem-mcp
npm run build
npm run pack
```

Build publishes `fivem-mcp/artificials/fivem-mcp/`. Pack also writes
`fivem-mcp/artificials/fivem-mcp.zip`, with one root and SHA-256 `hashes.json`.
Runtime npm dependencies are bundled; installation needs no workspace node_modules.

Stop the installed resource before replacing its files. The builder does not
start or stop FiveM. It uses unique staging, an exclusive lock and a backup.
Existing `config/` is preserved; unknown files outside it refuse publication.
ZIP files contain clean example configuration, never operator config.

Use an isolated output for development and tests:

```powershell
node fivem-mcp/scripts/build-http-mcp.mjs --out D:\Temp\fiveai-preview --pack
```

Install/link the complete directory and start it through FxDK or FXServer.
The loader uses the actual resource name and path, including spaces. A busy
configured port refuses startup instead of choosing another port.

## Configuration

Optionally create `config/config.json` using `config/config.example.json`:

```json
{"port":30130,"clientLogDirectories":[],"referenceOnline":false}
```

Only these keys are accepted. Port must be an integer from 1024 to 65535. Client
logs accept up to four absolute Windows directories. Invalid/oversized config
refuses startup. There is no environment-variable port override. Client log
attribution requires a unique file matching the current random binding marker.
Configuration is read on the host tick through `LoadResourceFile`, using the
actual resource name; it does not require Node filesystem read permission.

## Tools

`tools/list` provides JSON Schema 2020-12 arguments and outputs, plus current
availability notes. The seven built-in tools are always listed. `esx` appears
when `es_extended` is installed, `qbcore` when `qb-core` is installed, and `ox`
when at least one of `ox_lib`, `ox_target` or `oxmysql` is installed. Installed
but stopped or unsupported versions remain listed with a reason. Refresh
`tools/list` after resource changes; calls check availability again. This HTTP
transport does not send `tools/list_changed` notifications.

| Tool | Behavior |
| --- | --- |
| status | Native JS mode, bindings, dependencies, logs and queue; optional client filter |
| queue | Status, pre-dispatch cancellation and evidence-based recovery |
| execute_lua | Server/client function body and multiple return values |
| execute_js | JavaScript ES2022 function body, args, top-level await/return |
| resource | Exact-name list/status/start/stop/restart; self stop/restart refused |
| logs | Filtered bounded records and explicit coverage; omitted `side` selects `client` |
| esx | ESX Legacy 1.15.2 explicit methods and projected player data |
| qbcore | QBCore 1.3.0 explicit methods and projected player data |
| ox | ox_lib 3.39.0, ox_target 1.18.1, oxmysql 2.14.1 |
| reference | Pinned offline summaries and optional allowlisted online fallback |

Example execute_js arguments:

```json
{"side":"server","code":"const n = await Promise.resolve(42); return n;"}
```

Example execute_lua arguments:

```json
{"side":"client","clientId":7,"code":"return PlayerPedId()"}
```

Calls may return unfinished Tasks after the initial wait. Query by taskId using
queue. Unknown execution pauses FIFO; recovery probes retained evidence and
never replays code. Resource restart drops memory and does not undo effects.

For `logs`, `side` accepts `client`, `server` and `all`. With `client` or `all`,
omit `clientId` only when exactly one ready client is bound. No ready client
returns `TARGET_UNAVAILABLE`; multiple ready clients require `clientId`.
Unavailable client log sources return `LOG_SOURCE_UNAVAILABLE` for client-only
queries. `all` keeps separate server and client coverage, even when client
collection is unavailable. Callers that previously omitted `side` to read
server and client logs must now pass `side: "all"` explicitly.

Client history starts immediately after the latest `Game finished loading!`
line before the current binding, including startup logs emitted before MCP
became ready. The `gta-core-five` channel may be absent in the file; color codes
are ignored when recognizing the boundary. The binding marker identifies the
client; it is not the history start and is never returned. A missing load
boundary leaves the file source unlocated rather than mixing earlier sessions.

Server history includes the entire available `GetConsoleBuffer()` snapshot at
MCP startup, followed by live console output. Snapshot lines have no original
channel metadata, so their resource is unknown; use `contains` or an unfiltered
server query to include them. If history is unavailable, coverage reports
`partial` while live collection continues. Host buffer retention, the shared
10,000-line/16 MiB store, and the query limit still apply; this is not an unlimited
disk archive. Coverage timestamps are collection times, not original event times.

SQL outside the conservative SELECT grammar requires form elicitation on the
original tools/call POST SSE stream. The complete operation needs approve=true
within 120 seconds. Unsupported clients, decline, disconnect, session closure
and dependency changes cannot authorize writes. Chat approval is not a substitute.

## Runtime boundaries

This is trusted local development tooling, not an untrusted-code sandbox.
HTTP binds IPv4 loopback, checks Host/Origin and pins protocol 2025-11-25.
POST and DELETE are supported; GET subscriptions, replay and batches are not.
Clients must support sessions and POST SSE responses.

`execute_js` replaces `execute_ts`; the previous name is not an alias. Input is
an ES2022 async function body, with `args` and `mcp` parameters. A bundled JS
parser checks syntax before dispatch. TypeScript annotations, module imports,
exports and direct require calls are rejected as `JAVASCRIPT_INVALID`. This
syntax policy is not an isolation or security boundary.

Execution begins on Host Tick. After `await`, server natives/exports must run
inside a **synchronous** `mcp.host(callback)` callback. Nested async code and
callbacks need the same explicit handoff. Both server and client provide it:

```javascript
const value = await Promise.resolve(42);
return await mcp.host(() => ({value, resource: GetCurrentResourceName()}));
```

`mcp.host(async () => ...)` does not make the callback's later continuations run
on Host Tick. Detached callbacks and unawaited effects are outside the task's
completion boundary. The execution timeout cannot interrupt a synchronous loop;
timeouts keep the unknown-execution/FIFO recovery semantics. Queue/history,
inputs/results, sessions, logs and online fetches remain bounded.

Console command fiveai_mcp_report emits status. `status.javascript` reports
native ES2022 execution and explicit host access; `status.compiler` is removed.
Server bundles are not client download entries. Missing optional frameworks do
not prevent resource startup. Reference provenance and bundled licenses travel
with the resource.

The client runtime does not require browser TextEncoder/performance globals.
Client Lua maintenance uses SetTimeout and stops rescheduling after resource stop.
A local FxDK game must complete its MCP binding before client execution works.
For local client logs, run the packaged `client-log-bridge.mjs` on the computer
running FiveM, alongside the resource:

```powershell
node client-log-bridge.mjs --log-dir 'D:\FiveM\FiveM.app\logs'
```

Keep that process running while reading `logs` with `side:"client"`. The bridge
reads only `CitizenFX*.log`, sends bounded batches to the loopback MCP listener,
and proves client attribution with the current binding marker. `coverage` changes
to `available` after the first accepted batch; a stopped bridge becomes
`unavailable` after ten seconds. The endpoint does not listen on a public address.
The resource's own Node filesystem access is sandboxed, so configuring
`clientLogDirectories` with a directory outside the resource may return
`ERR_ACCESS_DENIED`. Existing file-directory collection remains supported where
the FXServer host permits it.

## Verification

```powershell
cd fivem-mcp
npm test
py -3.11 fivem-mcp/tests/fixtures/http-lua-check.py
```

Lua checks require Python 3.11 and lupa with Lua 5.4. Tests only build temporary
fixtures. Host acceptance must record artifact/buildId, server/client execution,
lifecycle, logs, frameworks, SQL effects and Codex/Claude Code/CodeBuddy behavior.
The optional JS benchmark runs 20 samples per 1/16/64KiB valid input and deep
syntax error class, with median/max and concurrent status latency.

Run `node fivem-mcp/scripts/benchmark-http-mcp.mjs --help` for the explicit host
benchmark runner. Its results measure tool latency, not isolated parsing cost.
