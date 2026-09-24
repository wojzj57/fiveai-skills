# Local MCP connection

The AI client's MCP transport must run on the same machine as FXServer/FxDK.
`127.0.0.1` inside a container, WSL environment or remote service may refer to a
different machine/network namespace. This resource listens on IPv4 loopback;
adding its URL to a cloud connector does not make the local endpoint reachable.

Use the ready line's address. Defaults:

| Setting | Value |
| --- | --- |
| Name | `fivem-mcp` |
| Transport | Streamable HTTP |
| URL | `http://127.0.0.1:30130/mcp` |
| Authentication | No token required by this local resource |

This is an HTTP resource already running in FiveM. Do not configure a stdio
launcher or an old `/sse` endpoint for it.

## Codex CLI

```powershell
codex mcp add fivem-mcp --url http://127.0.0.1:30130/mcp
codex mcp list
```

If the current session does not discover the newly configured tools, open a new
Codex session and call `status`. A saved configuration is not a successful call.
The `--url` option is supported by the local CLI; see also the
[official Codex MCP documentation](https://developers.openai.com/codex/mcp/).

## Claude Code

```powershell
claude mcp add --transport http --scope project fivem-mcp http://127.0.0.1:30130/mcp
```

Alternatively, merge this entry into the project's `.mcp.json`, preserving other
configured servers:

```json
{
  "mcpServers": {
    "fivem-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:30130/mcp"
    }
  }
}
```

Use `/mcp` to inspect connection status and handle any project configuration
approval requested by Claude Code. See the
[official Claude Code MCP guide](https://code.claude.com/docs/en/mcp).

## Other local AI clients

Add a Streamable HTTP MCP server using the settings above. Configuration keys vary
between applications; use their HTTP server settings instead of assuming they all
consume Claude Code's JSON. Refresh discovery, then call `status` with `{}`.

## Direct HTTP diagnostics

Use the client's MCP transport when available. When diagnosing the endpoint with
a raw HTTP client, keep the following sequence in one session:

1. POST `initialize` with `protocolVersion: "2025-11-25"`, a `clientInfo` object and
   `capabilities: {}`. Use `Content-Type: application/json` and
   `Accept: application/json, text/event-stream`.
2. Capture the response's `Mcp-Session-Id`. Send it and
   `MCP-Protocol-Version: 2025-11-25` on subsequent requests.
3. POST `notifications/initialized` promptly, within the 10-second initialization
   window. Then POST `tools/list` and `tools/call` for `status`.
4. Parse the JSON-RPC payload in SSE `data:` records when the response is
   `text/event-stream`. The SSE POST response is part of Streamable HTTP; it does
   not mean the server supports the old SSE transport.
5. DELETE the same endpoint with the session headers when finished. For later
   calls, retain the session or initialize a fresh one; resource restarts invalidate
   existing sessions.

Example `tools/call` body after initialization:

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"status","arguments":{}}}
```

Opening `/mcp` in a browser sends GET, which this release does not support.
Neither a failed GET nor a successful TCP connection proves MCP tool availability.

| Symptom | Next check |
| --- | --- |
| Connection refused | Resource startup, ready address and whether the client is on the same machine |
| Address already in use | Another installed resource/project using the configured port |
| Unknown or expired session | Complete initialization promptly; reconnect after resource restart |
| `execute_ts` / `status.compiler` | Old artifact is still running; verify the intended resource copy |
| `clients: []` | Enter the local game and check the client resource startup/binding |

For SQL writes through `ox`, the client also needs MCP form elicitation support.
An empty-capabilities diagnostic client can inspect status but cannot complete
that confirmation flow.
