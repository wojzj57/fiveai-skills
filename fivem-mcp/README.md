# FiveAI FiveM MCP

FiveAI FiveM MCP is a local, server-only Streamable HTTP MCP resource for
FXServer. The resource listens only on `127.0.0.1` and moves native calls to
the FiveM host tick.

Build the deployable resource from the repository root:

```powershell
pnpm build
```

The command produces the complete resource in:

```text
fivem-mcp/artificials/fivem-mcp/
```

Link that directory into the server resources, refresh FxDK, then start
`fivem-mcp`. The endpoint is `http://127.0.0.1:30130/mcp`.

See [http-mcp/README.md](./http-mcp/README.md) for the current tool surface,
the `FIVEAI_MCP` runtime records, and real-host verification requirements.
