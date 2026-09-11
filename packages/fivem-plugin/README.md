# fiveai-mcp — FiveAI FiveM debug MCP (unified artifact)

One directory, one ZIP: a FiveM resource and the desktop MCP entry live
together, share one `mcp/config.json`, and generate their credentials on
first start. Nothing else needs to be installed or copied.

## Requirements

- Windows with Node.js **>= 22.12.0** preinstalled (`node` on PATH, or use
  an absolute node path in your AI client).
- A FiveM test server (FXServer) or an FxDK project.
- The `fiveai-mcp.zip` built from this repository.

## Layout

```text
fiveai-mcp/
├─ fxmanifest.lua            FiveM resource manifest
├─ README.md                 this file
├─ dist/server.js            Server bundle (Node 22 CJS)
├─ dist/client.js            Client bundle (ES2020, no Node APIs)
├─ shared/executor.lua       shared Lua executor
└─ mcp/
   ├─ entry.mjs              desktop MCP stdio entry (Node ESM)
   ├─ broker.mjs             desktop broker (spawned by the entry)
   ├─ windows-files.ps1      credential ACL/publish helper (desktop only)
   ├─ config.json            the one shared configuration
   ├─ credentials.json       generated on first run — never share it
   └─ state/                 broker runtime state, generated at runtime
```

The ZIP contains exactly the files above except `credentials.json` and
`state/`, which are created locally at runtime.

## Install from the ZIP

1. Unpack `fiveai-mcp.zip` anywhere you like — the path may contain spaces
   and the directory is self-contained. All relative paths in the config
   resolve against `mcp/`, so moving the directory later keeps working.
2. Enable the resource in your **test** server (`server.cfg`):

   ```cfg
   ensure fiveai-mcp
   ```

   In FxDK, enable the resource in your project instead. The resource
   directory name can be changed; it locates its own `mcp/config.json`
   through the live resource path.

3. Point your AI client at the desktop entry: command `node`, arguments
   `<path-to>\fiveai-mcp\mcp\entry.mjs`. No config argument is needed — the
   no-argument entry reads the `config.json` next to itself.
   (`node entry.mjs --config <absolute-path>` still works for explicit setups.)

On first start the entry generates `mcp/credentials.json` (two independent
32-byte random tokens, Windows ACL restricted to your user and
Administrators, no-inheritance) and then starts the broker. The FiveM
resource waits for the credentials to appear and connects on its own, in
either startup order (AI first or resource first).

## mcp/config.json

```json
{
  "version": 1,
  "broker": { "host": "127.0.0.1", "port": 43189 },
  "stateDir": "./state",
  "credentialFile": "./credentials.json",
  "clientLogDir": null,
  "serverLabel": "local-fivem",
  "verifyEnabled": false
}
```

- The three data paths may be omitted (defaults shown). Relative values
  always resolve against the config file's own directory — never the
  process working directory.
- `host` is fixed to `127.0.0.1`; `port` is 1–65535, default 43189. The
  program never picks another port on its own.
- `clientLogDir: null` only means no client-log source is configured.
- Unknown fields are rejected; old full v1 configurations remain readable.
- The retired `fiveai_mcp_broker_url` / `fiveai_mcp_bridge_token` /
  `fiveai_mcp_verify_enabled` convars do nothing in this unified resource.
  There is exactly one configuration source: this file.

Restart rules: config changes are read at process/resource start. After a
`verifyEnabled` change, restart the resource. After any change that affects
connections or the configuration digest (port, paths, serverLabel,
verifyEnabled), stop every entry, wait for the old broker to exit, then
restart the resource. Mixed old/new program versions report
`INSTANCE_CONFLICT` by design — stop and replace both ends together.

## Credentials

`mcp/credentials.json` holds `entryToken` and `bridgeToken` (strict
two-field JSON, standard Base64 of >= 32 random bytes each). It is created
once by the desktop entry, never overwritten, and its access is restricted
to the current user and Administrators with inheritance disabled. Do not
commit, share, or hand-edit it; the broker and the FiveM resource only read
it.

Manual reset: stop the AI entry, the broker, and the resource, delete
`mcp/credentials.json`, then start the entry again — a new pair is
generated. There is no rotation command and `build`/`pack` never reset
credentials.

Existing (e.g. migrated) credential files must meet the same permission
boundary; the entry verifies the ACL and refuses to run with a clear error
instead of silently loosening or rewriting it.

## Host verification

After connecting a FiveM client, set `"verifyEnabled": true` in
`mcp/config.json`, restart the resource, and run in the **server console**:

```text
fiveai_mcp_verify server
fiveai_mcp_verify 12
```

Replace `12` with the connected client's server ID. These console commands
run five fixed probes (lua-await-multiple-nil, lua-vector, lua-error,
javascript-await, javascript-error) and print `FIVEAI_MCP_VERIFY` lines with
structured observations. They accept no code, are gated to the server
console, and are observations — not attestations from a potentially
compromised client. Turn `verifyEnabled` off after verifying. Client output
contains `FIVEAI_MCP_SESSION <marker> <serverId> <clientEpoch>`; find the
exact marker in your CitizenFX log directory and confirm one file per
active epoch.

## Upgrade

1. Stop the AI entry, the broker, and the FiveM resource; wait for the
   broker to exit.
2. Unpack the new ZIP into a **temporary directory**.
3. Copy only the program files into your installation, preserving your
   `mcp/config.json`, `mcp/credentials.json`, and `mcp/state/`:
   `fxmanifest.lua`, `README.md`, `dist/server.js`, `dist/client.js`,
   `shared/executor.lua`, `mcp/entry.mjs`, `mcp/broker.mjs`,
   `mcp/windows-files.ps1`.
4. Restart.

**A plain "unpack everything over the old directory" is NOT safe**: the ZIP
carries the default `mcp/config.json`, so a full overwrite replaces your
configuration. Preserve your `mcp/config.json` yourself if you unpack in
place. Credentials and state are never in the ZIP, but keep the resource
stopped while copying.

## Rollback and migration

- Rolling back to an older version of this same unified artifact reuses
  your existing config, credentials, and state.
- Rolling back to the old split installs (separate `fivem-plugin` resource
  plus convars) requires the old configuration structure, the old convars,
  and the old resource paths. The new config's `null`/`verifyEnabled` fields
  are rejected by the old strict parser.
- Migrating from an old split install: stop all old entries and resources,
  wait for the old broker to exit, place this package, transcribe the
  settings you still use into `mcp/config.json`, and either let first run
  generate fresh credentials or move the old credential file over — but the
  moved file must meet the permission boundary described above.
- Migrations never clear pending recovery state; resolve existing recovery
  blocks before switching.

## FxDK note

FxDK watches project files. Because the desktop entry writes
`mcp/credentials.json` and the broker writes `mcp/state/`, the watcher may
keep restarting the resource. Close the resource's auto-restart toggle in
FxDK and restart manually; code changes need a manual resource restart
anyway.

## Repository development

From the repository root:

- `pnpm run build` — build both packages and update `dist/fiveai-mcp/`
  (never a ZIP). Local `mcp/config.json`, credentials, and state are
  preserved.
- `pnpm run pack` — build, then produce a validated `dist/fiveai-mcp.zip`
  from a clean staging tree.
- `pnpm run build:resource` — compatibility alias for the unified build.
- `pnpm run test:all`, `pnpm run validate` — repository regression.

## Boundaries

Credentials and WebSocket code are Server-only; the client bundle contains
no Node APIs, tokens, or credential logic. Socket callbacks queue work for
the host tick and never call natives directly. Server Lua execution is a
local event, never a registered net event. The only incoming Server net
events are client registration, challenge confirmation, and correlated
results; they cannot initiate Server execution. The resource never accepts
an unauthenticated fallback when config or credentials are broken — it
reports the error kind and requires a restart after fixing.

Lua arguments preserve JSON arrays/objects and expose JSON null as
`JSON_NULL`. Lua results preserve multiple returns, nil and vectors;
JavaScript encodes undefined, BigInt and holes. Unsupported objects,
accessors, cycles and oversized results fail explicitly. Execution is not a
security sandbox.

Real FXServer/FxDK host acceptance (both startup orders, both probe
targets, resource renaming, client downloads) is tracked separately and was
**NOT_EXECUTED** at the time of this build.

Sources: [FiveM JavaScript runtime](https://docs.fivem.net/docs/scripting-manual/runtimes/javascript/),
[event security](https://docs.fivem.net/docs/developers/server-security/).
