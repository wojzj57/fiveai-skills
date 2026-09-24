# FiveAI FiveM MCP

FiveAI FiveM MCP runs as one FXServer/FxDK resource and serves Streamable HTTP MCP on IPv4 loopback. The default endpoint is `http://127.0.0.1:30130/mcp`. JavaScript execution is native ES2022; the release does not expose `execute_ts`.

## Build and install

From the repository root, with workspace dependencies installed, build the resource or create a distributable ZIP:

```powershell
npm ci
cd fivem-mcp
npm run build
npm run pack
```

Both commands publish the complete resource at `fivem-mcp/artificials/fivem-mcp/`. `pack` also creates `fivem-mcp/artificials/fivem-mcp.zip`. Install the directory that contains `fxmanifest.lua`, `dist/`, `lua/`, `data/`, and `config/`. Stop an existing installation before replacing it, and preserve its local `config/config.json`. The ZIP contains example configuration, not an operator's local configuration.

Place the resource in your server's resources directory and add `ensure fivem-mcp` to `server.cfg`. In FxDK, enable the resource in the project explorer and run the project server. The `FIVEAI_MCP ready` console record confirms startup and reports the actual address, resource epoch, and build. A client-side tool also needs a ready game-client binding.

## Connect and use tools

Connect an AI client on the same machine to the ready record's address using Streamable HTTP. Use [the skill's connection guide](../skills/fivem-mcp/references/connection.md) for client configuration. Discover tools, then call `status` with `{}` and compare its `resourceEpoch` and `buildId` with the running resource.

`tools/list` always includes the seven core tools: `status`, `queue`, `execute_lua`, `execute_js`, `resource`, `logs`, and `reference`. It includes `esx`, `qbcore`, and `ox` when their corresponding resources are installed. Stopped resources or unsupported versions remain discoverable with availability notes; calls still check availability. Refresh discovery after resource changes. The transport does not send `tools/list_changed` notifications.

Use [the skill's tool reference](../skills/fivem-mcp/references/tools.md) for arguments, task completion, log coverage, and adapter methods. A queued or running task is not a completed operation; inspect it with `queue`. Unknown execution can pause the FIFO and must be resolved from evidence before resubmitting a mutation.

## Configuration and logs

Optionally create `config/config.json` inside the installed resource. The supported keys are `port`, `clientLogDirectories`, and `referenceOnline`; defaults are port `30130`, no client log directories, and online reference fallback enabled. A custom port must be an integer from 1024 to 65535. Restart the resource after changing configuration. A busy port prevents startup.

`logs` defaults to the selected client. Use `side: "server"` for server output or `side: "all"` for server plus one client. With multiple ready clients, specify `clientId`. Read `coverage` with every result: an unavailable source or empty result does not establish that no errors occurred. Server history contains the available console buffer at MCP startup and subsequent live output.

For local client log history, run the packaged bridge on the computer running FiveM:

```powershell
node fivem-mcp/artificials/fivem-mcp/client-log-bridge.mjs --log-dir 'D:\FiveM\FiveM.app\logs'
```

Use the actual local log directory. If the resource uses a custom port, pass `--url http://127.0.0.1:<port>/mcp/client-logs`. Keep the bridge running while reading client logs. It reads `CitizenFX*.log` on that computer and attributes lines through the current binding marker. Direct `clientLogDirectories` collection remains available where the FXServer Node runtime can read those directories.

## Verify

```powershell
npm test
```

The repository tests use fixtures and shims. They do not establish real FxDK/FXServer, game-client, framework, database, or AI-client acceptance. See the [HTTP MCP implementation guide](http-mcp/README.md) for runtime boundaries and host verification requirements.
