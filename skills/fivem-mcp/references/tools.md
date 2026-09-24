# Tool reference

Each JSON block below is a `tools/call` **params** object: `name` is the tool and
`arguments` is its input. In an AI application's tool UI, supply only `arguments`.
Example client/player ID `7` must be replaced with the intended current ID.

Discover `tools/list` against the running server before calling a tool. The seven
core tools are always listed. `esx`, `qbcore` and `ox` appear when the matching
resources are installed; stopped or unsupported versions stay listed with an
availability reason. Refresh discovery after resource changes because this
transport does not send `tools/list_changed` notifications. Descriptions also
report current client and log availability. A call rechecks availability.

## Results and task completion

Read `structuredContent` (or the JSON text content when that is what the client
exposes). `ok: false` carries a structured error. Execution tools, resource changes
and adapter calls enter the global FIFO; `ok: true` with a task in `queued` or
`running` means accepted, not completed. Follow its returned `taskId` with `queue`.
Successful execution values appear in the task's `result.values`.

Client execution requires `side: "client"` and a ready `clientId` from `status`.
Server execution uses `side: "server"` without `clientId`. `playerId` in a
server-side framework call selects a player; it does not move execution to that
player's client. Execution and adapter timeouts accept 100–60000 ms, default 10000.

## status

```json
{"name":"status","arguments":{}}
```

Optionally supply `{"clientId":7}` to filter the client list. Inspect `javascript`,
`clients`, `dependencies`, `logs` and `queue` in the returned data. Frameworks are
optional: a missing framework does not mean HTTP or plain execution is broken.

## queue

```json
{"name":"queue","arguments":{"action":"status"}}
```

For a specific task, use `{"action":"status","taskId":"<returned taskId>"}`.
Copy the ID verbatim, including its epoch and sequence.

- `cancel` requires `taskId` and only cancels work before dispatch; it does not
  interrupt running FiveM code.
- `recover` requires an `unknown` task's `taskId`. It probes for matching terminal
  evidence. `RECOVERY_UNPROVEN` means execution is still unproven, not cancelled.
- An `unknown` task can pause the FIFO. Inspect/recover it instead of blindly
  resubmitting a mutation; timeout does not prove its side effects stopped.

## execute_lua

Server example with arguments and multiple return values:

```json
{"name":"execute_lua","arguments":{"side":"server","code":"return args.label, GetCurrentResourceName()","args":{"label":"probe"}}}
```

Client example:

```json
{"name":"execute_lua","arguments":{"side":"client","clientId":7,"code":"return GetEntityCoords(PlayerPedId())"}}
```

Send a function body, not a full resource. `args` is JSON input. Return values use
the wire encoding, including tagged values for nil, vectors and large integers.

## execute_js

```json
{"name":"execute_js","arguments":{"side":"server","code":"const n = await Promise.resolve(args.n); return await mcp.host(() => ({n, resource: GetCurrentResourceName()}));","args":{"n":42}}}
```

Client example:

```json
{"name":"execute_js","arguments":{"side":"client","clientId":7,"code":"return GetEntityCoords(PlayerPedId());"}}
```

Input is an ES2022 async function body with `args`, `return`, `await` and `mcp`.
It runs natively: TypeScript annotations, module imports/exports and direct
`require` calls are rejected as `JAVASCRIPT_INVALID`. `execute_ts` is not an alias.

Execution begins on Host Tick. After `await`, run server natives/exports inside a
**synchronous** `mcp.host(() => ...)` callback and await the result. The same helper
exists on clients. Passing an async callback does not keep its later continuations
on Host Tick. Detached work is outside the completion boundary; a synchronous
infinite loop cannot be interrupted by `timeoutMs`. The syntax check is not a
sandbox. Both Lua and JS snippets have a 64 KiB UTF-8 source limit.

## resource

```json
{"name":"resource","arguments":{"action":"list"}}
```

```json
{"name":"resource","arguments":{"action":"status","name":"exnui"}}
```

Use `start`, `stop` or `restart` with the exact resource `name`:

```json
{"name":"resource","arguments":{"action":"restart","name":"exnui"}}
```

Follow any queued task to completion and re-read `resource` status. Stopping a
resource unloads it for the current runtime; it does not remove its files or its
startup configuration. There is no uninstall action. The MCP resource refuses
to stop/restart itself; use the server console or FxDK to reload it.

## logs

```json
{"name":"logs","arguments":{"side":"server","resource":"exnui","limit":50}}
```

```json
{"name":"logs","arguments":{"side":"client","clientId":7,"contains":"error","limit":50}}
```

`side` accepts `server`, `client` (default) or `all`. Optional filters are exact
`resource`, `prefix` and `contains`; `limit` is 1–500 (default 100), and `includeRaw`
defaults to false. With one ready client, client/all reads select it automatically.
With multiple ready clients, supply `clientId`. With no ready client, client/all
reads return `TARGET_UNAVAILABLE`. Use `side: "all"` explicitly to include server
output; an omitted `side` does not select it.

Read `coverage` together with the lines: state, reason, retained/dropped counts and
gaps describe what was actually collected. Empty results are not proof that no
errors occurred. This is bounded collection, not an arbitrary log-file reader.

Server collection imports the entire available host console buffer at startup,
then follows live output. Historical buffer lines have no resource/channel
metadata; use `contains` or omit `resource` to find them. The host's retention and
MCP's bounded store/query limits still apply. If history cannot be read, server
coverage reports `partial` while live collection continues.

Client history starts after the latest `Game finished loading!` line before the
current binding, including logs before MCP binding. In the UI this is the
`gta-core-five` message; the file may omit that channel and include color codes.
Binding markers identify the client and are excluded from results. A file with
no matching load boundary remains unlocated. File message prefixes such as
`[exnui]` are used for resource filtering and may differ from the UI's original
script channel. Coverage timestamps are collection times.

For a local game client, run the `client-log-bridge.mjs` included at the root of
the installed resource on the computer running FiveM. Use the actual log path:

```powershell
node client-log-bridge.mjs --log-dir 'D:\FiveM\FiveM.app\logs'
```

Run this command from the installed resource directory, or use the script's full
path. Keep it running while you read client logs. If the MCP resource uses a
custom port, add `--url http://127.0.0.1:<port>/mcp/client-logs`. The bridge reads
`CitizenFX*.log`, sends bounded batches to the local endpoint, and uses the
current binding marker to attribute them. `coverage` becomes available after an
accepted batch and becomes unavailable when the bridge stops reporting.

Direct file collection is also supported when the server's Node runtime can read
the log directory. Configure an absolute Windows directory in the resource:

```json
{"clientLogDirectories":["D:\\FiveM\\FiveM.app\\logs"]}
```

The server must be able to access that directory; a path on another player's
machine is not readable merely because the player is connected. An FXServer Node
filesystem permission error can prevent direct reads outside the resource. Use
the local bridge in that case. `unconfigured`, `unlocated`, `ambiguous` or
`unavailable` coverage requires fixing the stated source/binding problem. A
client-only query with unavailable coverage returns `LOG_SOURCE_UNAVAILABLE`.
Do not attribute a different client's file to the target.

## Framework adapter prerequisites

Check `status.dependencies` for state, expected version and method availability
before calling an adapter. This release checks exact resource versions:

| Tool/library | Resource | Expected version |
| --- | --- | --- |
| `esx` | `es_extended` | `1.15.2` |
| `qbcore` | `qb-core` | `1.3.0` |
| `ox` / `ox_lib` | `ox_lib` | `3.39.0` |
| `ox` / `ox_target` | `ox_target` | `1.18.1` |
| `ox` / `oxmysql` | `oxmysql` | `2.14.1` |

Adapters expose the listed methods, not arbitrary framework calls. `args` is a
positional JSON array; consult discovery for each method's tuple schema. Player
objects are returned as serializable projections, not reusable live handles.

## esx

```json
{"name":"esx","arguments":{"side":"server","scope":"player","playerId":7,"method":"getMoney","args":[]}}
```

| Side/scope | Supported methods |
| --- | --- |
| Server / `framework` | `GetPlayerFromId` with `args: [playerId]` |
| Server / `player` + `playerId` | `getMoney`, `getJob`, `getAccount`, `addMoney`, `removeMoney`, `setJob` |
| Client / `framework` + `clientId` | `GetPlayerData`, `ShowNotification` |

For example, `getAccount` takes `["bank"]`, `setJob` takes `[jobName, grade]` with
an optional duty boolean, and money changes take `[amount]` with an optional
reason. These setters change live player state; use them for the requested action.

## qbcore

```json
{"name":"qbcore","arguments":{"side":"server","scope":"framework","method":"Functions.GetPlayers","args":[]}}
```

```json
{"name":"qbcore","arguments":{"side":"server","scope":"player","playerId":7,"method":"Functions.GetMoney","args":["cash"]}}
```

| Side/scope | Supported methods |
| --- | --- |
| Server / `framework` | `Functions.GetPlayers`, `Functions.GetPlayer` |
| Server / `player` + `playerId` | `Functions.GetMoney`, `Functions.AddMoney`, `Functions.RemoveMoney`, `Functions.SetJob`, `Functions.SetJobDuty` |
| Client / `framework` + `clientId` | `Functions.GetPlayerData`, `Functions.Notify` |

`Functions.GetPlayer` takes `[playerId]`; money changes take `[moneyType, amount]`
with an optional reason. `Functions.SetJob` takes `[jobName, grade]` and
`Functions.SetJobDuty` takes `[boolean]`.

## ox

Select a supported `library`; this tool has no `scope` field.

| Library/side | Supported methods |
| --- | --- |
| `ox_lib` / client + `clientId` | `notify`, `showTextUI`, `hideTextUI`, `isTextUIOpen` |
| `ox_target` / client + `clientId` | `isActive`, `disableTargeting`, `zoneExists`, `removeZone` |
| `oxmysql` / server | `query`, `single`, `scalar`, `insert`, `update`, `transaction` |

```json
{"name":"ox","arguments":{"side":"client","clientId":7,"library":"ox_lib","method":"notify","args":[{"description":"MCP connected","type":"inform"}]}}
```

```json
{"name":"ox","arguments":{"side":"client","clientId":7,"library":"ox_target","method":"isActive","args":[]}}
```

```json
{"name":"ox","arguments":{"side":"server","library":"oxmysql","method":"scalar","args":["SELECT 1"]}}
```

SQL methods take `[sql, parameters?]`; `transaction` instead takes a single array
of statement objects inside `args`, with the exact shape given by discovery.
SQL outside the conservative read-only SELECT grammar requires **MCP form
elicitation on the original call**. A client without that capability receives
`CONFIRMATION_UNSUPPORTED`. Do not add an `approved` field or use execution tools
to bypass a refused SQL confirmation. A successful confirmation is bound to that
request, session and dependency generation, not future database operations.

## reference

```json
{"name":"reference","arguments":{"query":"GetEntityCoords","category":"native","side":"client","limit":5}}
```

`query` is required. `category` accepts `native`, `event`, `guide` or `all`;
`side` accepts `server`, `client` or `all`; `limit` is 1–20 (default 5).
The bundled offline index is small, not the entire FiveM documentation set.
Online fallback depends on resource configuration and connectivity. Inspect each
item's source URL/revision and the response's warnings/`searchedOnline` fields;
an empty result is not proof that a native does not exist.
