# FiveAI FiveM HTTP MCP

`fivem-mcp` is a server-only FiveM resource that exposes a local Streamable
HTTP MCP endpoint from FXServer. It listens only on loopback and keeps FiveM
natives on the host tick.

## Build and deployment

From the repository root, run:

```powershell
pnpm build
```

The build stages the deployable resource at:

```text
fivem-mcp/artificials/fivem-mcp/
```

Point the FxDK resource link at that directory, refresh the resource list, and
start `fivem-mcp`. The resource serves MCP at:

```text
http://127.0.0.1:30130/mcp
```

The port is fixed to `30130` by default. A deliberate host-level override may
use `FIVEAI_MCP_HTTP_PORT`; invalid values fall back to the default and a busy
port leaves the resource failed rather than selecting another port.

## Tools

The current HTTP MCP surface contains three tools:

- `status` reports listener, session, host-tick, and runtime capability state.
- `native_read` reads a bounded set of FiveM native values on the host tick.
- `compile_ts` transpiles a bounded TypeScript snippet and reports its cost.

Run `fiveai_mcp_report` in the server console to print one structured status
record. Runtime lines use the `FIVEAI_MCP` prefix.

## Verification boundary

The automated suite exercises the HTTP transport, session lifecycle,
loopback-origin rules, host-tick queuing, stop cleanup, and port rebinding with
a simulated FiveM runtime. It does not prove FXServer compatibility. A real
FxDK/FXServer run must show `FIVEAI_MCP ready` before the endpoint is treated
as available.
