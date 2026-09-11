# FiveAI FiveM resource

This is the T02 host-verification bridge, loaded by FiveM through `fxmanifest.lua`.
It connects the real Server runtime to the desktop broker and binds game clients.
The desktop currently serves `status`; general execution tools, FIFO, framework adapters and recovery dispatch are not yet available.

## Build and install

From the repository root run `pnpm build:resource`. Copy the resulting
`packages/fivem-plugin/artifact/fivem-plugin` directory into your **test server's** resources directory as `fivem-plugin`.
The folder already includes its Server and Client bundles; no package installation runs inside FiveM.
The desktop and resource builds are independent.

Use private server settings (replace the token with the `bridgeToken` from the desktop credential file):

```cfg
set fiveai_mcp_broker_url "ws://127.0.0.1:43189/internal/v1/bridge"
set fiveai_mcp_bridge_token "YOUR_PRIVATE_BRIDGE_TOKEN"
set fiveai_mcp_verify_enabled "1"
ensure fivem-plugin
```

Never use `setr` or `sets` for the token. The resource does not edit server.cfg.
Start the desktop entry with `node packages/mcp/dist/entry.mjs --config <absolute-config-path>`.
A missing token leaves
the WebSocket disconnected; fixed host probes remain available if explicitly enabled.
Server JavaScript requires the FiveM Node 22 runtime selected by this manifest.

## Host verification

After connecting a FiveM client, run these commands in the **server console**:

```text
fiveai_mcp_verify server
fiveai_mcp_verify 12
```

Replace `12` with the actual connected client server ID. Client registration uses
the event sender, a random challenge and a fresh epoch. These commands accept no code;
they run five fixed probes, one at a time, in the selected host:

| Probe | Expected observation |
|---|---|
| lua-await-multiple-nil | After waiting: string `fiveai`, nil, number 7, nil; four returns |
| lua-vector | vector with dimension 3 and components 1,2,3 |
| lua-error | failed / EXECUTION_ERROR, executionCompleted=true |
| javascript-await | After waiting: string `fiveai`, undefined, bigint `42`, current resource name |
| javascript-error | failed / EXECUTION_ERROR, executionCompleted=true |

Server output uses `FIVEAI_MCP_VERIFY` followed by structured observations.
Results are checked for sender, active invocation, epoch, challenge and bounded wire format.
Compare them with the expected observations above; these are not cryptographic
attestations of execution by a potentially compromised game client.
A 10-second observation timeout reports unknown and retains the invocation;
it does not kill code or authorize a retry. A missing late result keeps further probes blocked.
These console probes are for T02 feasibility only, not an alternative production scheduler.
Turn off `fiveai_mcp_verify_enabled` after verification.

Client output contains `FIVEAI_MCP_SESSION <marker> <serverId> <clientEpoch>`.
Find that exact marker in the configured CitizenFX log directory. Confirm a unique
file for each active epoch, then repeat with a second client and reconnect.
A shared file without per-client attribution is **not** a passing mapping result.
Automatic client log tail/mapping is not implemented yet.

Record FXServer/FiveM versions, resource revision, console observations and marker
files separately for FxDK and direct FXServer. Node/VM tests are not host acceptance.
Currently real host results are **NOT_EXECUTED**.

## Boundaries

Credentials and WebSocket code are Server-only. Socket callbacks queue work for the
host tick. Server Lua execution is a local event, never a registered net event.
The only incoming Server net events are client registration, challenge confirmation
and correlated results; they cannot initiate Server execution.

Lua arguments preserve JSON arrays/objects and expose JSON null as `JSON_NULL`.
Lua results preserve multiple returns, nil and vectors; JavaScript encodes undefined,
BigInt and holes. Unsupported objects, accessors, cycles and oversized results fail
explicitly. Execution is not a security sandbox.

Sources: [FiveM JavaScript runtime](https://docs.fivem.net/docs/scripting-manual/runtimes/javascript/),
[event security](https://docs.fivem.net/docs/developers/server-security/).
