# RFC：FiveM 资源内嵌 Streamable HTTP MCP

日期：2026-09-20。状态：Draft — 产品方向已确认，技术契约待评审。本文仅用于设计，不授权实现、宿主操作、数据库写入、提交或发布。

关联：[迁移方案与实施顺序](../specs/fivem-mcp-http-migration-design.md)。

## 1. 决策、目标与优先级

在 FiveM 服务端资源的 Node 22 运行时启动 MCP HTTP Server，默认 `http://127.0.0.1:30130/mcp`。TypeScript 构建为 JS；资源停止则 HTTP 停止，宿主不在线时全部工具不可用。移除独立 stdio 入口、桌面 Broker、命名管道和内部 WebSocket。保留 10 个工具，任务与历史仅内存，无 Token 或身份鉴权。

本 RFC 对以下历史文件有明确替代范围；历史原文保留，不回写其批准或实现状态：

| 历史来源 | 继承 | 本文替代 |
| --- | --- | --- |
| [全量功能 RFC](../../fivem-mcp/rfcs/full-debug-mcp-completion-rfc.md) | 工具输入、方法白名单、执行值、SQL 业务确认、日志/资料行为 | 桌面生命周期、内部协议 v2、持久化任务、OS 身份恢复、离线工具可用性 |
| [原调试 RFC](../../fivem-mcp/rfcs/nodejs-debug-mcp-rfc.md) | 非冲突的业务语义 | stdio/Broker 通信、鉴权和调度作用域 |
| [一体化交付 RFC](../../fivem-mcp/rfcs/unified-artifact-rfc.md) | 单目录/ZIP、白名单构建、用户数据保留 | 包内桌面程序、config v1、凭据初始化与 ACL helper |
| [旧实施计划](../../../docs/superpowers/plans/2026-09-13-full-debug-mcp-completion.md) | 尚需完成的业务模块 | 不得继续按旧 Broker、write-ahead、internal/v2 任务实施 |

冲突优先级：本次用户确认的决策 > 本 RFC 经评审后的显式技术修订 > 上述非冲突业务要求。本文不是对全部技术细节的已批准声明。

非目标：远程访问、TLS/代理、OAuth、Token、身份隔离、持久化任务、跨重启恢复、stdio 兼容入口、FXServer 启停、MCP 自身重启、截图、NUI DevTools 代理、源码编辑工具。

## 2. 当前证据与可行性边界

- [manifest](../../../packages/fivem-plugin/fxmanifest.lua) 已使用 `node_version '22'`，服务端加载 `dist/server.js` 和 Lua 执行器。
- [资源构建](../../../packages/fivem-plugin/scripts/build-resource.mjs) 输出 Node 22 CJS 与无 Node API 的客户端 IIFE；构建入口当前仍是 JS，迁移时改为 TS 编写、JS 交付。
- [入口](../../../packages/mcp/src/cli/entry.ts) 列出 10 工具，但执行调用直接返回不可用；[Broker](../../../packages/mcp/src/broker/server.ts) 仅处理 status。
- [调度器](../../../packages/mcp/src/scheduler/task-scheduler.ts) 未接入生产链路，且 next 通过有截断的 list 选头；不能直接复用为完成版。
- SDK 依赖为 `@modelcontextprotocol/sdk@1.30.0`，本地包提供 `server/streamableHttp`。SDK 的 Node HTTP 适配可用于候选设计，不代表已在 FiveM 通过。
- 本会话旧架构的真实运行证据见迁移方案；本 RFC 没有运行新架构原型。

FiveM 官方文档说明服务端支持 Node 模块及 Node 22，同时提示 libuv 回调与宿主线程不同。P0 必须实测 Node HTTP listener、SDK 所需 Web API、停止后释放 socket，以及隔离编译能力；不能仅凭普通 Node 测试宣布宿主可用。[来源 S1]

## 3. 模块边界

| 模块 | 责任 |
| --- | --- |
| `packages/mcp/src/http/`（拟新增） | MCP transport、Host/Origin 检查、会话与 HTTP 资源清理；不直接调用 native |
| `packages/mcp/src/tools/` | 单一目录、严格输入/输出、业务路由、能力表达 |
| `packages/mcp/src/scheduler/` | 每 resourceEpoch 共享一份内存 FIFO、任务缓存、取消及同代对账 |
| `packages/mcp/src/execution/`（拟新增） | TS 编译、版本化执行计划、结果映射 |
| `packages/fivem-plugin/server/` | 资源启动配置、HTTP 组装、host-tick 调度、服务端执行及客户端路由 |
| `packages/fivem-plugin/client/`、`shared/` | 客户端绑定、ready/start/result/ack、Lua/JS 编码与执行 |
| adapters/logs/reference（拟新增） | 业务白名单、日志内存缓存、随包资料与受限官方回退 |

`packages/mcp` 成为可打包进资源的库，不是外部服务。HTTP 与宿主模块通过函数接口连接，不在同一进程内模拟旧 WebSocket 消息。共享 FIFO 跨 HTTP 会话和客户端目标，但不跨多个 FXServer；不同服务器必须使用不同端口。

## 4. HTTP 与会话契约

### 4.1 地址、边界和协议

- 默认监听 `127.0.0.1:30130`，路径固定 `/mcp`；不绑定 `0.0.0.0`、IPv6 通配符或 FiveM 公共游戏端口，不使用 `SetHttpHandler` 复用公共资源路由。
- Host 只允许规范化后的 `127.0.0.1:<port>` 或 `localhost:<port>`；拒绝缺失、多值、畸形或其他主机；不信任 forwarded headers。
- Origin 缺失允许；存在时仅允许 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`，拒绝 `null` 和其他来源，返回 403。默认不返回跨域许可，不用 `*`。
- 不要求 Authorization、Cookie、Token，不提供 OAuth。会话 ID 仅用于协议关联，不是身份或可信权限凭据；本机进程可以主动访问。
- 使用 SDK 1.30.0 的 Streamable HTTP transport，首版固定已验证的 2025 协议族，优先 `2025-11-25`，兼容本项目实测的 `2025-06-18`；最终支持集须由锁定 SDK 和客户端验收确认。不把 SDK v2 文档示例混入 v1 实现，不顺带升级协议时代。
- POST 承载 JSON-RPC；GET 提供 SSE；DELETE 关闭 MCP 会话。使用 SDK 验证版本、Content-Type、Accept 与 session header；未知路径 404，非法方法按 transport 返回 405。协议错误与工具业务错误分层，不把所有错误转换成 HTTP 500。

这是标准 MCP HTTP，不是自定义 REST。Streamable HTTP 支持 JSON/SSE 响应与会话规则，Origin 校验是协议安全要求。[来源 S2]

### 4.2 资源内会话

拟采用有状态 HTTP 会话：每次 initialize 创建独立 MCP Server/transport，共享工具服务与 FIFO。会话具有随机 sessionId、resourceEpoch 和初始化协商的能力。请求按 sessionId 路由；普通 TCP keep-alive 断开不能销毁会话。

资源重启后所有旧 sessionId 失效，返回 404；客户端重新 initialize，不能重放 tools/call。DELETE 和会话过期撤销未决审批；已入队/运行任务不因关闭会话自动取消。普通请求断开只结束等待；已派发副作用不可推断为取消。

拟定会话上限 32，未初始化请求等待上限 10s，空闲会话保留 30 分钟；有活动请求、审批或未终结自有任务时不按空闲清理。超限拒绝新增，不逐出活动会话。HTTP body 上限 1MiB，日志和工具自身另执行更小预算。以上为待评审的资源保护参数，不是已批准产品指标。

## 5. 配置、启动与停止

新配置仍位于资源 `mcp/config.json`，采用严格 version 2，拟定形状：

```json
{
  "version": 2,
  "http": { "host": "127.0.0.1", "port": 30130 },
  "serverLabel": "local-fivem",
  "clientLogDir": null,
  "verifyEnabled": false
}
```

字段默认值如上；http.port 为 1–65535 整数，host 只接受固定 loopback；未知字段拒绝。移除 broker、stateDir、credentialFile。clientLogDir 显式配置才启用客户端日志读取；相对路径仍相对于配置目录。使用 LoadResourceFile 在宿主 tick 读取资源内配置，不假定 Node fs 理解 `@resource`。

状态：`starting → ready → stopping → stopped`，配置或监听失败为 `failed`。启动时生成 resourceEpoch，完成配置、服务模块和监听绑定后才打印就绪地址/buildId/epoch。端口占用报告 `PORT_IN_USE`，无换端口、抢占进程或后备 stdio。失败应清理部分初始化资源，status 不伪装 ready。

停止时立即拒绝新任务，关闭 listener、transport、SSE、keep-alive sockets、timer、日志监听与编译 worker；不依赖 onResourceStop 中长时间 await 完成清理。P0 必须证明停止后端口释放和重复启动可用，具体宿主销毁钩子由验证决定。不得等待任意用户代码结束才释放网络资源，也不得声称关闭 HTTP 回滚了副作用。

任何迟到异步回调必须检查捕获的 resourceEpoch/停止标记，不能污染后续运行实例。MCP 自身 stop/restart 返回 `SELF_RESOURCE_PROTECTED`；FXServer 生命周期仅由 FxDK/人工管理。

## 6. 工具、任务与错误

### 6.1 公共范围

10 个名称与 [输入 schema](../../../packages/mcp/src/tools/schemas.ts) 保持一致；服务可用时 tools/list 恒定，缺框架不隐藏工具。所有业务错误用 `isError=true` 与 `structuredContent.error`，附同内容文本回退；输出须有严格 schema。

| 工具 | 新架构行为 |
| --- | --- |
| status | resourceEpoch/buildId、HTTP 状态与地址、真实客户端绑定、队列计数、内存保留策略、框架能力及日志覆盖；移除 broker PID、bridge、磁盘 recovery 和 OS 恢复资格 |
| queue | status 查询内存任务；cancel 仅同 MCP 会话创建且尚未派发的任务；recover 仅查询同代执行证据，不跨重启恢复 |
| execute_lua / execute_ts | 统一 FIFO，支持 server/client，严格 clientId；Lua 多返回/JS 特殊值沿用 wire-value |
| resource | list/status 只读；start/stop/restart 进入 FIFO；核实前后状态及代际，保护 MCP 自身 |
| logs | 服务端真实日志与显式配置的客户端日志；有界内存、覆盖/缺口/截断信息 |
| esx / qbcore / ox | 继承旧全量 RFC §9 完整方法清单、作用域和返回投影；资源代际在执行前复核 |
| reference | 随包资料优先，零命中才受限官方回退；宿主关闭后不可查询 |

框架缺失用 `FRAMEWORK_UNAVAILABLE`，方法缺失用 `METHOD_UNSUPPORTED`，目标失效用 `TARGET_UNAVAILABLE` 或 `TARGET_CHANGED`；不得使用“未注册”掩盖 handler 缺失。最终交付不得含 `scheduler not implemented` 等占位成功状态。

### 6.2 内存状态与并发

每次启动生成 resourceEpoch；taskId 为随机 UUID，sequence 在本代内递增。任务绑定 resourceEpoch、创建者 MCP sessionId、side、clientId/clientEpoch 和目标资源 generation。sessionId 约束仅用于避免客户端误取消他人任务，不提供身份安全保证。

状态为 queued/running/succeeded/failed/cancelled/unknown。全资源最多 100 queued 加 1 running-or-unknown。只读控制不经过 FIFO。next 必须取全部待执行任务中最早 sequence，不能使用展示列表的最后 N 条选择队首。满队列拒绝，不能淘汰未终结任务。

执行超时默认 30s、100ms–300s，按队首准备开始计算，包含编译、不含排队。工具同步等待上限 20s；超时返回仍可查询的 taskId/状态，不自动取消。终态保留最多 1000 条、30 分钟、总结果 32MiB；结果 256KiB、代码 64KiB、args 128KiB、深度 32、节点 10000；继承 [limits.ts](../../../packages/mcp/src/protocol/limits.ts)。活动/unknown 任务不参与终态淘汰。

未知结果占据执行槽：超时或客户端失联后，不能在缺少完成证据时运行下一项。`queue.recover` 只检查本代缓存/客户端绑定结果；精确匹配的迟到终态可结算。禁止“强制成功”、自动重放和用 HTTP 重连证明执行已结束。无证据保持 unknown。

重启后清空任务、结果、sequence、审批、会话及去重缓存。查询旧 ID 返回 `TASK_NOT_FOUND`，明确 `retention=memory-only` 与当前 epoch；无法区分“曾执行但已遗忘”和“从未执行”。同代提交重复 tools/call 也不承诺去重：JSON-RPC id 不是业务幂等键；文档要求禁止自动重试副作用请求。服务端到客户端的内部同 taskId 消息必须去重，二者不能混淆。

不写 recovery.json、任务 WAL、执行正文或结果快照。诊断日志只记有界元数据及错误种类，不记录代码/SQL/args/result；FXServer 自身可能保存其控制台日志，AI 客户端也可能保存会话或工具输出。“不保存任务”约束本 MCP 服务，不承诺清除宿主或客户端自行保存的记录。

### 6.3 执行与客户端协议

HTTP handler 只做校验、路由和等待；native/exports/Lua emit/客户端 dispatch 转交 host-tick。服务端执行直接调用宿主执行器。客户端保留绑定握手，并增加 epoch/taskId/planDigest 的 ready → start → result → ack；未收到 start 不执行，重复 start 不重复执行，结果在本代限额内保留至 ack。旧 epoch、错误 source、错误 challenge、目标变化拒绝。

客户端返回只是其执行观测，不能允许客户端发起服务端执行。资源重启使旧 binding 无效；客户端存在仍在运行的旧执行时不能冒充新绑定已空闲。计划必须在服务端和客户端边界再次验证。

TS 编译器、source map 与 SQL parser 随服务端 bundle；不在游戏客户端编译 TS。编译不得阻塞控制查询；拟用宿主内 worker，P0 验证其可用性。若 worker/必要 API 在 FXServer 不可用，作为技术阻塞重新评审隔离方案，不悄悄引入外部 Node 或无限同步编译。任意执行不是安全沙箱，死循环硬终止不在保证范围。

### 6.4 SQL 确认与日志迁移

继承旧全量 RFC §10 的保守 SQL 分类、完整调用摘要、300s 单次确认和不可变执行绑定。原 entry 会话改为原 HTTP MCP 会话；审批仅内存，客户端不支持 form elicitation 返回 `APPROVAL_UNSUPPORTED`。HTTP 请求取消、会话终止或资源停止撤销待审批，不通过聊天或其他会话代批。不做身份鉴权不等于允许未经业务确认的 SQL 写操作；任意代码执行工具依旧属于可信开发能力，SQL 表单不是防恶意本机进程的安全隔离。

服务端日志改在资源内采集，不再经 bridge 批发。客户端日志仍只读配置目录、按唯一会话标记定位；不扫描用户目录，不把同一个文件任意归属给多个客户端。FXServer 文件沙箱导致不可读时明确降级，不新增桌面 helper 绕过。此能力必须在 P0/P4 真实验证；缺失正向客户端日志证据不能宣布完整 logs 通过。

## 7. 交付、升级与回退

新 ZIP 保留资源 manifest、README、server/client bundle、Lua 执行与适配代码、配置 v2；按实际需要加入 worker/资料文件到显式白名单。禁止客户端分发 MCP SDK、编译器、服务端配置和 SQL 数据。buildId 覆盖所有新增源输入和数据。

旧 `mcp/entry.mjs`、`broker.mjs`、`windows-files.ps1` 属于已登记退役程序，迁移时明确移除；只增加新版文件会让旧客户端继续启动陈旧入口。旧 `config.json`、`credentials.json`、`state/` 和其他用户文件必须原字节备份保留，不自动清空。新代码不读取凭据和旧状态。

config v1 不静默解释为 v2：启动报告 `CONFIG_MIGRATION_REQUIRED`，由未来显式迁移命令/人工步骤备份旧配置，保留 serverLabel/clientLogDir/verifyEnabled，生成端口 30130 的 v2；不继承旧 broker.port=43189。新建安装使用默认 v2；正常 build 不覆盖已有配置。迁移工具的编写不属于本轮。

部署顺序：停止旧 MCP 入口/Broker 和资源 → 验证已停止 → 备份程序及用户数据 → 部署新白名单与配置 → 删除仅已知退役程序 → 将客户端改为 HTTP → 启动资源 → 执行验收。现有工程链接 `D:\FiveM\Projects\Dev\resources\[exs]\fiveai-mcp` 可继续指向 `D:\Exre\ex-fiveai\dist\fiveai-mcp`；构建前应停止资源，避免 watcher 读取混合产物。未经指令不自动修改链接或停止宿主。

旧 recovery 有 pending 时先明确其副作用不确定，再安排切换；不能把本次“不保存新任务”解释为自动清除旧执行风险。新架构不会导入或重放旧任务。

回退必须停止新版资源、恢复旧程序与备份的 v1 配置、恢复旧客户端入口，再启动旧架构。旧状态按旧规则解释；新架构运行期的任务没有磁盘记录可恢复。任何已产生的游戏/数据库副作用都不因程序回退自动撤销。

## 8. 客户端配置与兼容性

以下只给未来操作示例，本轮未修改任何客户端配置。已有同名 stdio 条目应先明确替换，避免同时启用两个服务。

```powershell
codex mcp add fiveai-mcp --url http://127.0.0.1:30130/mcp
claude mcp add --transport http fiveai-mcp http://127.0.0.1:30130/mcp
codebuddy mcp add --scope project --transport http fiveai-mcp http://127.0.0.1:30130/mcp
```

Codex 语法依据本机 `codex mcp add --help`；Claude Code 依据官方 HTTP 配置文档。[来源 S3] CodeBuddy CLI 示例依据官方 HTTP 配置文档；其 JSON 条目为 `{"type":"http","url":"http://127.0.0.1:30130/mcp"}`，无自定义鉴权 header。具体 CLI/IDE 版本及配置文件位置在验收时记录，以对应安装版本为准，不把名称相同视为版本兼容证明。[来源 S4]

每个客户端分别验证 initialize/协商版本、10 工具发现、status、双端执行、会话恢复和错误显示。支持 form 的版本验证 SQL 确认；不支持时验证明确拒绝，不能绕过确认。客户端 HTTP 支持与整个产品验收是两件事。

## 9. 验证矩阵与完成条件

所有项目初始为 NOT_EXECUTED。本次仅文档检查，不转写旧架构测试数。

| ID | 检查与预期证据 |
| --- | --- |
| A01 | 严格配置 v2、迁移拒绝、端口范围、固定 host、未知字段 |
| A02 | HTTP POST/GET/DELETE、非法版本/媒体类型/session、Host/Origin 拒绝；会话不随单次 TCP 关闭丢失 |
| A03 | 10 工具目录与路由逐一一致；业务错误结构、输出 schema，无占位成功 |
| A04 | 多会话 FIFO、公平队首、100 queued 限额、控制查询不阻塞、取消与 unknown |
| A05 | HTTP 断开不重放、不误取消；迟到结果/旧 epoch/重复 start/结果 ack |
| A06 | 重启清空所有任务；旧 ID 明确找不到；无任务/结果/审批落盘 |
| A07 | 双端编码、Lua await/多返回/向量、TS 编译/await/异常/source map、结果预算 |
| A08 | resource 自保护、普通资源生命周期与依赖错误；完整框架白名单和 SQL 审批拒绝/接受 |
| A09 | 日志过滤/轮转/标记/缺口；资料离线命中、官方回退超时与来源限制 |
| A10 | ZIP 白名单、退休程序清理、用户数据保留；无工作区 node_modules 的独立包运行 |
| H01 | 真实 FXServer 加载 SDK 并监听 30130；MCP 初始化与 native 只读调用成功 |
| H02 | 连续 10 次资源停止/启动，每次端口释放并可重绑；无外部 MCP Node 进程和残留会话 |
| H03 | 端口占用只报错；资源恢复后重新初始化；旧会话/任务不被重放 |
| H04 | 两个 AI 会话同时操作同一服务器/客户端，实际副作用次序与 FIFO 一致 |
| H05 | 客户端掉线、任务超时、MCP 重启、FXServer 重启；unknown 和结果遗忘符合契约 |
| H06 | 框架/数据库使用专用测试角色和记录，ESX/QBCore 分别验收；变更依赖和写数据库需届时明确授权 |
| H07 | 真实客户端日志读取、资源日志、TS worker、独立 ZIP 均在宿主内验证 |
| C01–C03 | Codex、Claude Code、CodeBuddy 分别记录版本、配置、协商协议、工具发现/调用、重连和确认支持 |

完成必须具备 handler、独立产物和真实证据。缺依赖的正确错误路径不能替代该功能正向验收。A 类自动化使用隔离 fixture，不覆盖运行中的 dist，不启动用户宿主；完整新架构验收在后续获授权的窗口执行。

## 10. 风险、替代方案与评审门槛

| 风险或取舍 | 处理/检查 |
| --- | --- |
| FXServer 定制 Node 与 SDK/worker 不兼容 | P0 实测；失败先修订方案，不声称普通 Node 通过等价宿主通过 |
| 重启中断后副作用无法追溯 | 用户接受内存-only；返回/文档明确未知，不自动重试 |
| 无鉴权，本机进程可执行高权限调试 | 已确认可信开发机边界；loopback 和 Origin 不被宣传为身份隔离 |
| 资源停止残留 listener/SSE | 停止钩子清理和 H02；只有资源重启后真实重绑才算通过 |
| 编译/任意同步代码拖慢宿主 | 有界输入、隔离编译、宿主时序观测；不承诺硬中断任意脚本 |
| 外部日志目录被沙箱限制 | 配置显式目录并真实验证；失败明示能力缺失，不偷偷加桌面进程 |
| 多服务器共用默认端口 | 第二实例明确报占用，由使用者配置独立端口 |

替代方案：继续外部 Broker 可保留离线查询与故障隔离，但不符合用户删除进程和持久化要求；资源启动外部 Node 子进程仍有宿主限制和残留生命周期，排除；复用 FiveM 公共 HTTP 端口难以落实独立 loopback 监听，排除。选择资源内 Node HTTP 独立端口。

产品决策无待问项。待技术验证项及决策点：P0 的 HTTP/worker/停止清理兼容性；P4 的日志文件读取；P6 的三客户端具体版本及 form 支持。由后续实施者提供证据；若阻塞已确认范围或需要改变公共契约，再提交用户决策，不自行删功能。本文拟定配置 v2、会话参数与错误/输出变更必须在实施前评审。

## 11. 来源与本轮验证

- S1：[FiveM JavaScript 运行时](https://docs.fivem.net/docs/scripting-manual/runtimes/javascript/)，2026-09-20 查阅；支持 Node 22 与线程边界，不证明本 SDK 在宿主内通过。
- S2：[MCP 2025-11-25 transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)，2026-09-20 查阅；本 RFC 锁定该协议族，不宣称它是唯一最新版本。
- S3：[Claude Code MCP](https://code.claude.com/docs/en/mcp)，2026-09-20 查阅；HTTP 配置语法依据。
- S4：[CodeBuddy MCP](https://www.codebuddy.ai/docs/cli/mcp)，2026-09-20 查阅；具体安装版本仍需 C03 验收。
- 本地依据：SDK 1.30.0 `dist/esm/server/streamableHttp.d.ts`、工具输入与 limits、资源 manifest/构建脚本、旧 RFC 和本会话实测。

本轮仅检查文档路径、相对链接、契约一致性及工作区变更范围；无新实现或宿主验收结论。
