---
name: fivem-mcp
description: FiveM MCP setup and runtime operations. Use when installing the FiveAI resource in FXServer or FxDK, connecting a local AI client, or using its execution, resource, log, framework, and reference tools.
---

# FiveM MCP

Install the ready-to-run FiveAI resource, connect to its local Streamable HTTP
endpoint, and operate the running FiveM project. Use `execute_js` for native
ES2022 JavaScript; this release does not expose `execute_ts`.

## Choose the entry point

- **Install or update:** follow Installation below. Use an existing resource
  artifact; this skill does not build or package the repository.
- **Connect an AI client:** read [Local connection](references/connection.md).
- **Use tools:** complete Verify the connection below, then read the relevant
  section of [Tool reference](references/tools.md) before forming arguments.

## Installation

Use the complete `fivem-mcp/` directory from the delivered ZIP, or the ready-made
`fivem-mcp/artificials/fivem-mcp/` directory if working from this repository.
Copy the directory containing `fxmanifest.lua`, `dist/`, `lua/`, `data/` and
`config/`; copying source files alone is not an installation. Runtime dependencies
are bundled, so the destination does not need npm installation.

For an update, stop the installed resource before replacing its files and retain
its local `config/config.json`. In FxDK, disable autorestart while copying so an
incomplete directory cannot be loaded. Run one copy per configured port.

### FXServer with server.cfg

1. Copy the artifact to the server data directory, for example:

   ```text
   server-data/
     server.cfg
     resources/
       [local]/
         fivem-mcp/
           fxmanifest.lua
           dist/
           lua/
           data/
           config/
   ```

2. Add this line to `server.cfg`. Keep any framework resources you actually use
   in their normal startup order; optional frameworks are not needed to start MCP.

   ```cfg
   ensure fivem-mcp
   ```

3. Start the server. If it is already running, use its **server console**:

   ```text
   refresh
   ensure fivem-mcp
   ```

Use the actual resource directory name if it differs from `fivem-mcp`.

### FxDK

1. Copy the complete artifact directory into the FxDK project.
2. Enable the `fivem-mcp` resource in the project explorer and run the project
   server. FxDK manages enabled project resources; use this route instead of
   editing generated resource startup configuration.
3. Read the FxDK server console. To use client-side tools, also enter the local
   game and wait for the MCP client binding to become ready.

FxDK accepts normal FiveM resources and can restart them when their files change.
See the [official FxDK resource guide](https://docs.fivem.net/docs/fxdk/resources/).

**Installation is verified when the running server prints `FIVEAI_MCP ready` with
the actual `address`, `resourceEpoch` and `build`.** A copied folder or an enabled
checkbox alone does not verify startup.

### Optional resource configuration

Create `config/config.json` inside the installed resource only when overriding
defaults. The supported keys are:

```json
{"port":30130,"clientLogDirectories":[],"referenceOnline":true}
```

The default port is `30130`; without configuration, online reference fallback is
enabled. A custom port must be 1024–65535 and must also be used in the AI client's
URL. Restart the resource after configuration changes. A busy port fails startup;
the service does not choose another port automatically.

For local client history, run the packaged log bridge on the game computer.
`clientLogDirectories` supports direct collection from up to four absolute Windows
directories when the server's Node runtime can read them. See the `logs` section
of the tool reference for setup and coverage requirements.

## Verify the connection

1. Connect from the same machine to the address in the ready line, normally
   `http://127.0.0.1:30130/mcp`, using **Streamable HTTP**. Follow the client-specific
   commands in [Local connection](references/connection.md).
2. Discover tools and call `status` with `{}`. Compare `resourceEpoch` and `buildId`
   with the running resource's ready line. The native release reports
   `javascript: {mode: "native", syntax: "ES2022", hostAccess: "explicit"}`.
3. If discovery still advertises `execute_ts` or status contains `compiler`, the
   endpoint is serving an older release. Check the installed artifact and resource
   path, replace the intended copy and restart it; do not treat old compiler
   errors as a native-JS requirement.
4. For client operations, select an actual `status.clients[].clientId` whose
   binding is ready. For adapters, check the corresponding dependency and method
   availability. Discover tools again after a resource change: optional adapters
   appear only when their resources are installed, and discovery has no change
   notification. Report server connectivity separately from these capabilities.

**Connection is verified only after both discovery and `status` succeed.** Tool
discovery alone does not establish that clients, frameworks or logs are available.

## Available tools

| Tool | Use |
| --- | --- |
| `status` | Inspect the service, clients, dependencies, logs and queue |
| `queue` | Inspect tasks, cancel before dispatch, recover unknown execution |
| `execute_lua` | Run a Lua function body on the server or a selected client |
| `execute_js` | Run an ES2022 JavaScript function body with explicit host callbacks |
| `resource` | List, inspect, start, stop or restart an exact resource name |
| `logs` | Read bounded client records by default, or server/all records explicitly, with coverage information |
| `esx` | Call the supported ESX framework/player methods |
| `qbcore` | Call the supported QBCore framework/player methods |
| `ox` | Call supported ox_lib, ox_target or oxmysql methods |
| `reference` | Search native, event and guide references |

Argument examples and method coverage live in [Tool reference](references/tools.md).
Use the connected server's `tools/list` schemas as the authority for accepted input.
When reporting an operation, distinguish accepted/queued work from a terminal
result; verify the resulting resource state or returned execution values.
