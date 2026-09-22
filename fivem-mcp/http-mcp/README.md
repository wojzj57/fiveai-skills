# FiveAI FiveM HTTP MCP

A single resource serves Streamable HTTP MCP at `http://127.0.0.1:30130/mcp`.
No external broker, compiler service or compilation Worker is required.

Real FxDK/FXServer, two-client, framework/database and AI application acceptance
remain **NOT_EXECUTED**. Node shims and Lua 5.4 tests are not FiveM acceptance.

## Build and install

From the repository root with dependencies installed:

```powershell
corepack pnpm --dir fivem-mcp build
corepack pnpm --dir fivem-mcp pack
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

## Tools

`tools/list` provides the exact JSON Schema 2020-12 arguments and outputs.

| Tool | Behavior |
| --- | --- |
| status | Compiler, bindings, dependencies, logs and queue; optional client filter |
| queue | Status, pre-dispatch cancellation and evidence-based recovery |
| execute_lua | Server/client function body and multiple return values |
| execute_ts | TypeScript function body, type erasure, top-level await/return |
| resource | Exact-name list/status/start/stop/restart; self stop/restart refused |
| logs | Filtered bounded records and explicit coverage |
| esx | ESX Legacy 1.15.2 explicit methods and projected player data |
| qbcore | QBCore 1.3.0 explicit methods and projected player data |
| ox | ox_lib 3.39.0, ox_target 1.18.1, oxmysql 2.14.1 |
| reference | Pinned offline summaries and optional allowlisted online fallback |

Example execute_ts arguments:

```json
{"side":"server","code":"const n: number = await Promise.resolve(42); return n;"}
```

Example execute_lua arguments:

```json
{"side":"client","clientId":7,"code":"return PlayerPedId()"}
```

Calls may return unfinished Tasks after the initial wait. Query by taskId using
queue. Unknown execution pauses FIFO; recovery probes retained evidence and
never replays code. Resource restart drops memory and does not undo effects.

SQL outside the conservative SELECT grammar requires form elicitation on the
original tools/call POST SSE stream. The complete operation needs approve=true
within 120 seconds. Unsupported clients, decline, disconnect, session closure
and dependency changes cannot authorize writes. Chat approval is not a substitute.

## Runtime boundaries

This is trusted local development tooling, not an untrusted-code sandbox.
HTTP binds IPv4 loopback, checks Host/Origin and pins protocol 2025-11-25.
POST and DELETE are supported; GET subscriptions, replay and batches are not.
Clients must support sessions and POST SSE responses.

TypeScript 5.9.3 loads as ordinary dist/compiler-runtime.cjs from the actual
resource path. Compilation is synchronous in the server Node event loop. The
5000ms preparation budget is checked after return, and cannot interrupt CPU work.
Over-budget preparation faults TS until explicit restart; Lua/HTTP can continue
when the event loop runs. Dispatch rechecks session, targets and generations.

Server async continuations run through Host Tick. Detached callbacks and
unawaited effects are outside the completion boundary; native/exports calls must
obey FiveM scheduling rules. Queue/history, inputs/results, frames, sessions,
logs and online fetches have explicit bounds. No automatic replay is performed.

Console command fiveai_mcp_report emits status. FIVEAI_MCP compiler records costs
without source or arguments. Compiler/server bundles are not client download
entries. Missing optional frameworks do not prevent resource startup. Reference
provenance and bundled dependency licenses travel with the resource.

## Verification

```powershell
corepack pnpm --dir fivem-mcp test
py -3.11 fivem-mcp/tests/fixtures/http-lua-check.py
```

Lua checks require Python 3.11 and lupa with Lua 5.4. Tests only build temporary
fixtures. Host acceptance must record artifact/buildId, server/client execution,
lifecycle, logs, frameworks, SQL effects and Codex/Claude Code/CodeBuddy behavior.
Compiler performance requires 20 host samples per 1/16/64KiB valid input and deep
syntax error class, with median/max and concurrent status latency.

Run `node fivem-mcp/scripts/benchmark-http-mcp.mjs --help` for the explicit host
benchmark runner. Capture compiler console records alongside its latency output.
