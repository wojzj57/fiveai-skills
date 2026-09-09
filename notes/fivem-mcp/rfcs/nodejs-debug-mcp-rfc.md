# RFC：FiveM Node.js 本机调试 MCP

日期：2026-09-09  
状态：待技术评审；未实施。  
范围基线：[已确认设计](../specs/2026-09-09-nodejs-debug-mcp-design.md)。该文档已在本轮对话获用户确认，保留原文，不改写其历史状态。  
旧实现依据：[架构与源码报告](../../fivem-mcp-architecture-and-nodejs-rewrite-report.md)。

## 1. 决策摘要

在现有 FiveAI Skills 工作区新增 Node.js 调试子系统。每个 AI 客户端以 stdio 启动入口，共用一个回环地址 Fastify broker；broker 通过 WebSocket 连接 MCP 专用资源的 Server 桥接，Server 再通过 FiveM 网络事件分派到指定 Client。

所有运行操作使用一个 FIFO。代码仅由 MCP 资源内的 Lua/JS 执行器接收，TypeScript 在桌面 Node.js 侧转换。其他资源通过自己的 exports 接受调试；本地代码修改交给 AI 的文件工具。保留 10 个工具、框架适配、全局日志与核心参考查询。截图只定义禁用契约，没有捕获代码、依赖或工具注册。

本 RFC 将已确认产品选择转成具体技术约束；容量、默认超时、首版方法集和文件布局是本 RFC 的工程选型，不是已存在实现。真实宿主和三种客户端均未验收。

## 2. 当前边界与不迁移内容

外层 [package.json](../../../package.json) 是 private 的 fiveai-skills 包，只有插件验证与 Node 测试，发布文件目前为 skills 和 cordis.patch.yml。现有 [插件验证器](../../../scripts/validate-plugin.mjs)检查多宿主 metadata 一致性、Skill frontmatter 和目录内链接，不能直接用修改产品名称的方式绕过这些约束。

新模块放入外层工作区，不在 fivem-mcp-main 下原地改造 Laravel。保留旧源码和原报告供追溯。不迁移网站、旧 MCP Prompts/Resources、模板生成工具或 Prodigy；不注册文件操作、FXServer 启动、NUI/CDT 代理和截图工具。外层已有其他 Skills 不因这次 MCP 范围调整而被删除。

运行支持 Windows 本机、FxDK 或直接 FXServer，一次一个服务器环境、多 AI 会话、多客户端。MCP 不远程管理跨机器服务器，不接管 txAdmin，也不实现强制终止任意 Lua/JS 的沙箱。

## 3. 代码与交付布局

以下均为拟新增路径，本 RFC 本身不创建这些代码：

```text
mcp/
  package.json / package-lock.json
  src/
    cli/                 stdio 入口、进程启动和配置读取
    broker/              Fastify、会话、连接、生命周期
    protocol/            v1 内部消息与公共工具 schema
    scheduler/           FIFO、任务状态、恢复记录
    execution/           TS 转换、目标分派、结果编码
    adapters/            方法清单、参数校验、SQL 分类
    logs/                Server 消息、Client 文件、查询
    reference/           索引、排序、官方回退
    tools/               10 个 MCP 工具注册
    contracts/           screenshot.disabled.ts，仅类型和常量
  data/reference/        已核实的随包资料与来源清单
  data/adapters/         版本与方法清单
  tests/                 单元、协议、进程级集成测试
  dist/                  桌面 Node 发布产物
resources/fiveai-mcp/
  fxmanifest.lua
  server/                Server JS 通道、Lua 执行和适配
  client/                Client JS/Lua 执行
  shared/                编码、消息校验和方法清单生成产物
skills/
  fivem-mcp/             安装、调试、恢复工作流
  fivem-nui-debug/       Chrome DevTools MCP 操作
  ox-target/            新增对应知识
  esx-framework/        更新现有内容
  qbcore-framework/     更新现有内容
  oxlib/                更新现有内容
  oxmysql/              更新现有内容
```

桌面与资源分别构建。根包保持名称、现有宿主清单和 DeepSeek Skills 分发行为；增加明确的 MCP 构建/测试入口及发布文件清单。Skill 里的引用放各自目录内；不能链接到相邻 Skill 或 mcp 源码来违反已有校验规则。可由同一适配清单生成各 Skill 的方法参考副本，测试保证同步。

首版以插件发布包附带构建后的 MCP 与桥接资源，AI 客户端用 node + 入口绝对路径启动。安装示例引导填入实际安装路径；不依赖每次启动 npx 下载、不在 MCP 启动时安装依赖。不在本 RFC 凭空加入未知的宿主 manifest 字段；各宿主先通过文档化的 stdio 配置接入。

### 3.1 技术基线

2026-09-09 通过 npm registry 核实以下版本存在，选为初始精确版本；这不是互操作测试结果。实现时将直接依赖精确写入 mcp/package.json 并生成 lock，禁止使用 latest 或无上界范围。

| 项目 | 选型 |
|---|---|
| 桌面运行时 | Node.js 22 LTS 系列，最低 22.12.0；发布测试记录实际补丁版本 |
| FiveM Server JS | fxmanifest 指定 node_version '22'，与桌面依赖独立打包 |
| MCP SDK | @modelcontextprotocol/sdk 1.30.0，使用稳定 v1 API |
| Fastify | 5.12.3 |
| WebSocket | @fastify/websocket 11.3.0，ws 8.21.3；关闭可选原生加速依赖 |
| Schema | zod 4.5.4；工具 schema 和内部消息从同一声明产生 |
| TypeScript | 5.9.3，用于工程类型检查与语法检查 |
| 构建/片段转换 | esbuild 0.28.2 |
| SQL AST | node-sql-parser 5.4.0，MySQL 方言，未知结构进入确认 |
| Lua | FiveM Lua 5.4 运行时 |
| 测试 | Node 内建 node:test；桥接行为另做宿主测试 |

桌面模块 ESM；Server JS 打包为适合 FiveM 加载的单文件，不打包 Node 内建模块；Client JS 输出无 Node builtins、无 require/import 依赖的脚本，转换目标 ES2020。TS 片段也按 ES2020 转换。依赖内潜在 native payload 不自动视为支持 FiveM；仅 ws 及桥接自己的代码进入 Server bundle，esbuild、SQL parser、MCP SDK 留在桌面。

参考：[MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[Fastify WebSocket](https://github.com/fastify/fastify-websocket)、[FiveM JS runtime](https://docs.fivem.net/docs/scripting-manual/runtimes/javascript/)。

## 4. 本机配置与生命周期

### 4.1 配置契约

入口接受 --config <absolute-path>，不接受通过工具参数覆盖连接地址或读取任意文件。配置 JSON 结构：

```json
{
  "version": 1,
  "broker": { "host": "127.0.0.1", "port": 43189 },
  "stateDir": "C:\\Users\\name\\AppData\\Local\\FiveAI\\mcp",
  "credentialFile": "C:\\Users\\name\\AppData\\Local\\FiveAI\\mcp-token.json",
  "clientLogDir": "D:\\FiveM\\FiveM.app\\logs",
  "serverLabel": "local-development"
}
```

示例路径需要安装时替换。host 首版仅允许 127.0.0.1；port 可在安装配置时更改，入口不能自动跳端口而使桥接失联。一个 OS 用户使用一个全局 broker/stateDir；同一运行实例拒绝配置摘要不同的入口，避免多个配置悄悄形成两个“全局”队列。更换 stateDir 属于安装配置变更，不是队列恢复手段。

credentialFile 只允许当前用户和系统管理员可读，包含独立随机的 entryToken 和 bridgeToken；至少各 32 字节随机数据。安装由 Skill 引导本地 AI 或用户创建，MCP 不改 server.cfg。Server 使用不复制给客户端的 convar 读取 bridgeToken 与 broker URL，禁止使用 replicated convar 或客户端脚本携带凭据。

stateDir 只存自己的 runtime.json、owner 锁和 recovery.json。日志、代码、SQL、绑定参数不写入它。文件路径在启动时规范化并检查真实路径、junction/symlink 归属，后续内部文件名固定；不接受工具传入路径。

### 4.2 启动竞争

入口先做鉴权探测，无服务时用固定 named pipe 名取得本用户启动互斥，持有 pipe 的入口启动隐藏 broker 子进程，windowsHide=true，stdio 独立。pipe 名由本用户标识摘要构造；它是启动互斥，不携带工具协议。

broker 另外持有固定的本用户 lifetime named pipe，名称独立于配置路径、端口和 stateDir；它与入口短期持有的 startup pipe 分开。只有同时取得 lifetime pipe 和配置端口独占监听的进程才能持有调度权、打开恢复记录和写 runtime.json。lifetime pipe 的只读发现响应给出端口、协议和配置摘要，入口仍需随后通过 token 验证 WebSocket 身份。另一配置不能因为改端口而创建第二个全局调度器。

入口先查询 lifetime pipe，再竞争 startup pipe。pipe 名按安装时确定的 Windows 用户 SID 摘要生成，不用可变用户名或配置摘要代替。端口或 lifetime pipe 已占用且无法证明是有效同身份服务时退出 PORT_IN_USE/INSTANCE_CONFLICT；不 kill、不自行换端口。broker 任一步启动失败必须释放已取得句柄且不得启动调度。

runtime.json 包含 PID、brokerInstanceId、协议版本、配置摘要和启动时间，只是发现信息。入口必须通过鉴权握手验证，不能凭 PID 或文件认定实例有效。broker 异常退出由 OS 释放监听句柄；旧 runtime 文件通过新的鉴权握手判定失效，不能用“锁文件过期”强行夺权。

### 4.3 会话与退出

WebSocket 每 5 秒心跳；15 秒无有效响应即失联。AI 入口断开后取消该入口仍 queued 的任务与待确认请求；running/unknown 保留。其他会话的队列不受取消影响。

最后入口失联后 30 秒宽限期内可重新连接；到期后拒绝新任务、取消剩余 queued 请求、落盘未解决任务、关闭连接和服务。停止期间的新入口收到 SHUTTING_DOWN 并在旧服务退出后重新探测，不能同时生成第二调度器。

bridge 断线重连采用 1/2/4/8 秒后封顶 10 秒的退避并加入抖动。入口重连连接层可以重试，但不自动重发工具操作。协议兼容条件为 internalProtocol=1 且适配/构建兼容 ID 匹配；不兼容返回更新说明，不自动重启桥接或其他会话。

## 5. 内部通信与身份

### 5.1 通道

Fastify 路由为 /internal/v1/entry 与 /internal/v1/bridge，均为 WebSocket。升级前校验 loopback 地址、正确角色的 Authorization bearer token、Host；不提供 CORS 浏览器接口，携带浏览器 Origin 的连接拒绝。令牌不进入 query string。

监听消息处理器同步注册，再执行异步初始化，避免初始化期间丢消息。限制每帧 1 MiB，禁用压缩；超出限制关闭连接并按下发状态处理在途任务。

公共信封字段如下，未知字段拒绝，v 必须为 1：

```json
{
  "v": 1,
  "id": "uuid",
  "type": "task.submit",
  "brokerInstanceId": "uuid",
  "sessionId": "uuid",
  "payload": {}
}
```

握手前只有 hello 允许缺省 brokerInstanceId/sessionId；握手成功后由 broker 分配或绑定，不能由发送者自报另一会话身份。日期字段采用 UTC ISO 8601，耗时使用单调时钟。id 用于消息请求/响应；taskId 用于执行，不能混用。重连回报旧任务时，信封使用当前 broker/session，payload 带 originalBrokerInstanceId 和原任务目标身份，必须与恢复记录匹配；不能因为 broker 换代丢弃可验证的迟到终态。

| 消息 | 方向 | payload 的必需语义 |
|---|---|---|
| hello / welcome | 双端建立连接 | role、protocol、buildId、配置/适配摘要；返回绑定身份与容量 |
| ping / pong | 双向 | nonce；不改变任务状态 |
| task.submit / task.accepted | entry → broker / 返回 | tool、validated arguments、requestId；返回 taskId、sequence、state |
| task.dispatch / task.received | broker → bridge / 返回 | taskId、目标完整身份、执行内容、deadline；received 不是完成 |
| task.result | bridge → broker → entry | taskId、目标身份、终态、返回/错误、耗时 |
| task.resultAck | broker → bridge | 已接收并更新恢复记录的 taskId，允许释放完整结果 |
| task.status / task.statusResult | broker ↔ bridge | 查询已有 taskId，不携带代码、不执行重试 |
| approval.request / approval.result | broker ↔ 原 entry | approvalId、请求摘要与展示内容；关联原工具调用 |
| logs.batch | bridge → broker | streamId、sequence、records、droppedCount |
| clients.snapshot | bridge → broker | 当前绑定的 server ID、clientEpoch、能力、日志标记 |
| control.request / control.result | entry ↔ broker | status、queue、日志及资料等工具请求/结果 |

### 5.2 Server 与 Client

每次 Server 桥接启动生成 bridgeEpoch；服务器进程身份使用 Server JS process.pid 与本机可核验的进程创建时间，不把 bridgeEpoch 当 FXServer 生命周期。若本机进程身份无法核验，状态注明不可验证，不接受据此进行环境恢复。

Client 握手时 Server 按实际事件 source 分配 clientEpoch 和随机挑战，映射 serverId → clientEpoch。旧 serverId 被重用后，旧 epoch 的任务失败 TARGET_SESSION_CHANGED。Client 接收任务时确认 Server 来源及当前挑战，Server 接收结果时核对实际 source、epoch、taskId 和唯一在途任务。

仅 Client 的注册握手和任务结果需要网络事件。Server 执行片段入口不得注册为可由客户端触发的 net event。JS/Lua 同资源通信使用本地事件或私有 exports，关联随机内部调用标识；不会在其他资源安装代码。

所有 FiveM natives、exports 及 Lua 事件切换从宿主调度线程执行。Server ws I/O 回调只入站排队，由 setTick 驱动处理；不能从 Node I/O 回调直接假定可以调用所有 natives。Client 与 Server Lua 返回都先在原运行时编码成 wire value 再跨语言传递。

## 6. 公共工具输入、结果与容量

### 6.1 Schema 通则

所有输入对象 additionalProperties=false。method 是精确、区分大小写的清单键，禁止 __proto__、prototype、constructor 路径及运行时任意属性遍历。resource name 是非空字符串且不得含路径分隔符、控制字符或通配符；最大 128 字符。

ID：clientId/playerId 为正安全整数。client side 必须 clientId；server side 禁止 clientId。args 为 JSON；框架/ox args 必须数组，片段 args 默认为空对象。字符串按 UTF-8 字节限额，整数范围先校验再分配任务。

| 工具 | 规范输入 |
|---|---|
| status | {} 或 {clientId}，后者只筛客户端展示，不改变全局信息 |
| queue | action=status 可选 taskId、limit；cancel 必填 taskId；recover 可选 taskId（缺省当前阻塞任务） |
| execute_lua / execute_ts | side、code 必填；clientId 条件必填；args 可选；timeoutMs 可选 |
| resource | action 必填；list 不带 name；其余必填 name；变更可带 timeoutMs |
| logs | side 默认为 server；clientId 条件必填；resource/prefix/contains 可选非空字符串；limit、includeRaw 可选 |
| esx / qbcore | side、scope、method 必填；scope=player 必须 playerId 且 side=server；scope=framework 禁止 playerId；其余遵循方法清单 |
| ox | library、side、method 必填；library 只允许 ox_lib/ox_target/oxmysql；args 默认为 [] |
| reference | query 必填；category 默认 all，枚举 native/event/guide/all；side 可选 client/server/shared；limit 可选 |

logs side=client/all 时，若仅一个已关联客户端可省略 clientId；多个时返回 TARGET_AMBIGUOUS；无客户端时返回 TARGET_UNAVAILABLE。all 是 Server 加选定一个 Client。客户端已离线但当前会话记录仍保留时，必须显式提供 ID 且通过当前会话身份核对；不跨启动查旧日志。

### 6.2 默认限制

以下是首版工程默认值，统一声明在 limits 模块，状态工具展示有效值；不得绕过 schema 静默提升。

| 项目 | 值与行为 |
|---|---|
| 执行 timeoutMs | 默认 30,000；范围 100–300,000；资源变更同样适用 |
| 工具同步等待 | 入队后最多等待 20 秒；未终态即返回 taskId 与 queued/running，使用 queue.status 查询 |
| 待确认等待 | 300 秒，超时视为取消；不占 FIFO |
| 队列 | 最多 100 个 queued，全局最多 1 个 running/unknown；满则拒绝，不驱逐已有任务 |
| 每入口未完成确认 | 最多 5 个，超出直接拒绝 |
| code / args | code 64 KiB，args 编码 128 KiB；数据库确认展示总长最多 32 KiB，超限要求拆分 |
| 普通结果 | 256 KiB，编码深度 32、元素总数 10,000 |
| 已完成任务缓存 | 最多 1,000 条或 30 分钟，先到先清；未解决任务不驱逐；完整结果总量最多 32 MiB |
| 每日志流 | 最多 50,000 条或 16 MiB；全局日志内存最多 64 MiB，最早采集记录先淘汰并记录缺口 |
| 日志查询 | limit 默认 100、最大 1,000；响应最大 512 KiB |
| 单日志行 | 最多 64 KiB，过长截断并标记；不无限缓冲未换行内容 |
| reference | limit 默认 10、最大 50；query 最大 256 字符；在线总预算 8 秒 |

20 秒只限定工具等待，不终止远端任务，也不是 timeoutMs。queued/running 为成功取得任务状态的响应，不设置 isError。排队开始前就失效的任务按 failed 返回；已经下发却无法判断终止的任务按 unknown 处理。

### 6.3 结果编码

MCP 工具返回 structuredContent，并提供同内容 JSON 文本回退。不输出图片或二进制附件。执行结果封装为 taskId、state、target、queuedMs、executionMs、result 或 error；结果期限结束仅保留摘要时，queue.status 返回 resultAvailable=false，不能伪装为空结果。

wire value 使用完全带标签的递归格式，避免用户对象键与编码标签冲突：

| kind | value / 语义 |
|---|---|
| null、nil、undefined | 无 value，区分 JSON null、Lua nil、JS undefined |
| boolean、string、number | 对应标量，number 只允许有限值 |
| int64、bigint | 十进制字符串，避免 JSON 数字精度损失 |
| specialNumber | NaN、Infinity 或 -Infinity 字符串 |
| array | wire value 数组；JS hole 编码为 hole 标签 |
| object | 字符串键与 wire value 的键值对数组，避免原型赋值 |
| map | 非字符串键或稀疏 Lua table，entries 为 wire key/value 对；不强转普通对象 |
| vector | dimension 为 2/3/4，components 数字数组；用于 FiveM vector |
| bytes | base64 与字节数；只在结果限额内，不写文件 |

Lua 返回 {language:"lua", returns:[...]}，通过 table.pack 的 n 保留尾部 nil；JS 返回 {language:"javascript", value:...}。Lua 连续正整数键 table 编码为 array，空 table 约定 object，混合键为 map；输入 JSON array/object 的来源标记在解码时保留，JSON null 使用桥接专用哨兵并由适配器处理。

function、thread、未知 userdata 和循环引用返回 RESULT_UNSERIALIZABLE，并带字段路径。结果过大返回 RESULT_TOO_LARGE，不返回虚假完整数据。两者表示远端函数已经结束，任务 failed、executionCompleted=true，队列可前进；数据库结果过大不表示写入失败或回滚。

框架玩家对象走显式快照投影，返回快照使用同一编码：ESX 为 source、identifier、name、job、accounts；QBCore 为 PlayerData 中 source、citizenid、charinfo、money、job、gang、metadata，缺少字段明确省略并列 omittedFields。不得遍历执行 getters 或序列化函数；不提供远程对象 handle。

### 6.4 错误

协议错误交 MCP SDK 处理。已知工具的校验或业务错误用 isError=true 与结构化 error.code。主要代码固定为 INVALID_ARGUMENT、TARGET_UNAVAILABLE、TARGET_AMBIGUOUS、TARGET_SESSION_CHANGED、FRAMEWORK_UNAVAILABLE、METHOD_UNSUPPORTED、PLAYER_NOT_FOUND、QUEUE_FULL、QUEUE_PAUSED、TASK_NOT_FOUND、TASK_NOT_CANCELLABLE、TIMEOUT_UNKNOWN、CONNECTION_LOST_UNKNOWN、RECOVERY_EVIDENCE_REQUIRED、STATE_STORE_ERROR、COMPILATION_ERROR、EXECUTION_ERROR、RESULT_UNSERIALIZABLE、RESULT_TOO_LARGE、APPROVAL_UNSUPPORTED、APPROVAL_DECLINED、APPROVAL_CANCELLED、APPROVAL_EXPIRED、LOG_MAPPING_FAILED、REFERENCE_UNAVAILABLE、SELF_RESOURCE_PROTECTED。

unknown 错误必须附 sideEffectsUnknown=true 和 retrySafe=false。已结束的写操作即使返回业务失败，也不自动建议重试；只有未下发且确认无执行的错误可以 retrySafe=true。

## 7. 调度、持久化与恢复

### 7.1 顺序

broker 完成输入校验、目标会话绑定与必要确认后，在同一事件循环分配递增 sequence 并入队。TS 编译在任务占有队首后执行，编译失败直接终态；它不会因并行编译快慢改变接收顺序。任务占有队首即开始 timeoutMs 计时，包含转换和分派。

queue.cancel 仅允许取消原会话提交的 queued 任务，取消已下发任务报 TASK_NOT_CANCELLABLE。queue.status 为全局可见；本机多个 AI 属同一用户信任域，但确认仍绑定原始入口与 OS 用户配置。queue.recover 可由任一已鉴权入口触发，它只验证事实，不授权新副作用。

### 7.2 下发原子边界

发出 task.dispatch 之前先写 recovery.json：版本、broker ID、taskId、目标 epoch、工具类别、phase=dispatch_intent、生成时间。写临时文件、flush、同目录原子替换；替换失败保留阻塞状态并停止下发，不删除旧记录后再写。

dispatch_intent 落盘后任何崩溃都按“可能下发”恢复，即使实际可能还未发送。每次只有一个需要持久化的在途任务。收到并核验终态后，先持久化 settled 摘要，再对桥接发 resultAck 和启动下一任务。corrupt/未知格式恢复记录返回 STATE_STORE_ERROR 并暂停，不能清空后继续。

任务代码、SQL、args、数据库结果和输出仅在内存。已终态简短记录最多保留 100 条，不含敏感输入；未解决记录不清理。broker 重启后 queued 不重放，未确认请求失效，完整结果不保证保留。

### 7.3 远端终态缓存

Server 和 Client 对唯一在途任务保留终态及完整结果，直到收到 resultAck；再保留 taskId 与终态摘要用于短期去重。broker 断开时执行器可以继续完成并暂存结果，重连后仅回报已有结果，不重新执行。

同一 taskId 的重复 dispatch 不运行第二次；若请求内容/目标摘要不同返回协议冲突并暂停。任务状态查询无代码字段；没有记录只返回 unknown，不能以“没找到”证明从未执行。

### 7.4 恢复证据矩阵

| 证据 | 行为 |
|---|---|
| 从未形成 dispatch_intent，任务仍 queued | 可以取消，不涉及执行恢复 |
| 原执行器回报且身份匹配的 succeeded/failed | 记录终态，自动解除该任务阻塞 |
| 已保存的 settled 摘要与恢复记录一致 | 可恢复调度；完整结果缺失时如实告知 |
| 仅 received、桥接连接恢复、bridgeEpoch 改变 | 不充分，继续暂停 |
| 仅 clientId 重新在线、Client 重连 | 不充分，继续暂停 |
| 仅 FXServer PID 变化 | 通用片段、框架和数据库任务不充分，继续暂停 |
| 资源生命周期任务，旧 Server 进程已证实退出、新 Server 身份核实且资源状态可读 | 可解除生命周期控制的调度阻塞，旧任务仍记 unknown；不推断资源业务副作用已撤销 |

环境恢复例外仅适用于 MCP 自己实现的资源生命周期任务，且无仍在途的桥接执行命令；不扩展到任意片段、exports 或数据库。对通用执行，首版只自动认可原任务终态或 settled 记录。无法获知间接副作用的任务可能一直暂停，这是已确认“不强制继续”的实际限制，不提供 secret reset、force 或换会话绕过。

外部人工排查可能证明风险已经解除，但首版没有接收自由文本证明或人工“忽略未知任务”的接口。若产品后续需要这条恢复能力，必须另外定义可审计证据契约；不能由实现者临时删除 recovery.json 当作恢复。

日志/status/reference 以及 queue 控制通道始终不受运行队列暂停约束；运行时主线程完全卡死时，broker 只能展示缓存状态和“目标无响应”，不能保证新的资源状态读取成功。

## 8. 执行器

Lua 用 load 构建函数体，args 为局部参数，运行在 Citizen 协程内，用 xpcall 获取错误与堆栈，table.pack 捕获多返回值。只提供已有 FiveM 全局环境和输入，不附加文件 API；环境隔离用于减少意外变量残留，不宣称安全沙箱。

TS 先解析成函数体 AST，拒绝静态 import/export、动态 import 和显式 require；包装 async function(args) 后经 esbuild 转换为 JS 函数表达式，送到对应 JS 运行时执行并 await。AST 拒绝是首版语法约束，不是阻止恶意代码获取运行时能力的隔离边界。不做依赖安装、不跨任务缓存用户变量。

为每个 task 使用唯一虚拟源文件名和 source map，返回片段行号与可用原始堆栈。编译器错误发生在下发前，executionCompleted=false 但 noRemoteExecution=true，可安全结束队列任务；运行后序列化失败为 executionCompleted=true。

不等待 detached thread、timer 或未 await 的 Promise。执行器只在能报告函数结束后发终态；超时由 broker 观测，不向用户伪称杀死代码。桥接仅检查到期前是否尚未开始；已经运行的代码没有通用撤销语义。

## 9. 框架适配清单

### 9.1 版本与调用约定

下列是源码研究固定点，由 git ls-remote 核实；它们是适配开发基线，不是“实机已验证版本”。发布前测试必须记录安装资源版本和提交，方法清单中 sourceRevision 采用这些值：

| 资源 | 研究提交 |
|---|---|
| ESX esx_core | fe59ca0bd6da59e2ec6eb4a8d06ece312e96ae7a |
| QBCore qb-core | 9b3cddcce93e5e12cbcf6b47b866b687d32ac7bf |
| ox_lib | b8f5a04351b1d427e0e112150d36094e9889ec7b |
| ox_target | bf03d52c09cb5f677ac063531740fddcb51ca7cf |
| oxmysql | 030d3bda11098fc4a78f1940545b674c374daa45 |
| FiveM 源码参考 | 0d8a2a6f78a9922445d8930305af82a7b1826980 |

通过 exports 获取框架对象，每次调用重新解析玩家对象；不缓存旧玩家引用。方法清单每项声明 tool、side、scope、method、argumentSchema、invocation、resultProjection、resourceRevision。兼容运行时只探测声明过的 API 是否存在，不能因为版本字符串未知就推断调用成功。

ESX/QBCore 主适配器使用 Lua，保留框架 closure 的调用方式；不要人为多传 self。下表 ? 为可选，所有写操作也进入 FIFO。方法名相对于框架对象；ox_lib 相对于 lib，oxmysql 使用其原方法基名；不新增统一业务方法。

### 9.2 ESX 首版

| side / scope | method | args | 返回 |
|---|---|---|---|
| server/framework | GetPlayerFromId | [serverId] | 玩家快照或 nil |
| server/framework | GetExtendedPlayers | [key?, value?, minimal?] | 按 key/value 查询后投影玩家快照；不返回函数 |
| server/framework | GetJobs | [jobType?] | 数据表 |
| client/framework | GetPlayerData | [] | 客户端玩家数据快照 |
| server/player | getName、getJob、getMoney | [] | 原方法数据 |
| server/player | getAccount | [accountName] | 账户数据 |
| server/player | getInventoryItem | [itemName] | 原物品数据 |
| server/player | addMoney、removeMoney | [amount, reason?] | 原返回值 |
| server/player | setJob | [jobName, grade, onDuty?] | 原返回值 |

最小玩家数据模式仍通过相同投影规则，不能假定 minimal 改变后的对象一定带完整方法；投影缺失字段列入 omittedFields。

### 9.3 QBCore 首版

| side / scope | method | args | 返回 |
|---|---|---|---|
| server/framework | Functions.GetPlayer | [serverId] | 玩家快照或 nil |
| server/framework | Functions.GetPlayers | [] | server ID 数组 |
| server/framework | Functions.GetQBPlayers | [] | ID 与快照映射 |
| server/framework | Functions.GetDutyCount | [jobName] | 原返回值 |
| client/framework | Functions.GetPlayerData | [] | PlayerData 数据 |
| server/player | Functions.GetMoney | [moneyType] | 原余额 |
| server/player | Functions.AddMoney、Functions.RemoveMoney | [moneyType, amount, reason?] | 原返回值 |
| server/player | Functions.SetJob | [jobName, grade] | 原返回值 |
| server/player | Functions.SetMetaData | [key, value] | 原返回值 |

研究版本虽然内部已使用 Player class，仍保留 Functions 方法表；适配器使用用户确认的 Functions 路径，不直接绑定内部 class 方法。原生字段读取不伪装为函数：玩家完整数据通过 framework Functions.GetPlayer 的快照获取。

### 9.4 ox_lib 首版

首版选择可通过库 exports 调用的 UI 方法，不为桥接 fxmanifest 添加无条件 @ox_lib/init.lua，从而允许未安装 ox_lib 时桥接继续工作。每次调用先检查资源与方法，使用 Lua exports 以保留等待语义。

| side | method | args | 完成边界 |
|---|---|---|---|
| client | notify | [data] | 方法返回，通知视觉停留不占后续队列 |
| client | inputDialog | [heading, rows, options?] | 用户提交或关闭后返回 |
| client | alertDialog | [data, timeout?] | 对话结束后返回 |
| client | progressBar、progressCircle | [data] | 进度结束或取消后返回 |
| client | progressActive | [] | 即时状态 |

只接收 JSON 可表达参数；函数参数不接受代码字符串自动转换。inputDialog/进度等待纳入全局 FIFO，因此不能指望另一个排队的 close/cancel 方法解锁当前任务；首版不暴露这些工具适配方法，用户在游戏内取消，超时后仍依照队列规则处理。

lib.callback.await 等导入型 API 不在这份首版适配清单。后续需要时单独补足导入生命周期、注册清理和参数契约，不能将未知方法直接当 exports 调用。通用片段可使用目标资源为此暴露的 exports。

### 9.5 ox_target 首版

均为 client：isActive([])、disableTargeting([boolean])、zoneExists([number|string])、addSphereZone([data])、addBoxZone([data])、removeZone([id, suppressWarning?])、addModel([models, options])、removeModel([models, optionNames])。

zone data 的 coords 使用明确的 [x,y,z] 数组，box size 同理；适配器按该方法 schema 转为 vector3，结果恢复为数值 ID。options 必须有稳定 name，只允许 JSON 字段，如 label、icon、distance、event、serverEvent、command、export；onSelect/canInteract 等函数字段拒绝，使用目标资源 exports 解决。

ox_target 按 GetInvokingResource 记录所属资源，MCP 调用创建的交互属于 MCP 资源。按库真实权限删除：有些操作只影响调用者自己的选项，不能保证删除任意其他资源注册内容。工具不伪造调用资源名称。停/重启桥接或 ox_target 会丢失其运行时注册内容，不在 broker 重连时自动重建。

### 9.6 oxmysql 首版

仅 server，method 为 query、single、scalar、insert、update、prepare、rawExecute、transaction。非 transaction 的 args 为 [sql, parameters?]；parameters 为位置数组或命名参数对象，缺省 []。transaction args 为 [[{query, values?}, ...]]，不接收函数式 startTransaction、不接收 SQL store 数字句柄。

JS 适配器调用源库对应 method_async export，并等待原 Promise，原错误 rejection 进入执行失败。public method 保留原基名，调用映射在 Skill 标明。prepare/rawExecute 仍需展示全部执行参数；首版不支持隐式批量参数组，要求拆成明确事务条目。

源码依据：[ESX player](https://github.com/esx-framework/esx_core/blob/fe59ca0bd6da59e2ec6eb4a8d06ece312e96ae7a/%5Bcore%5D/es_extended/server/classes/player.lua)、[QBCore player](https://github.com/qbcore-framework/qb-core/blob/9b3cddcce93e5e12cbcf6b47b866b687d32ac7bf/server/player.lua)、[ox_lib init](https://github.com/overextended/ox_lib/blob/b8f5a04351b1d427e0e112150d36094e9889ec7b/init.lua)、[ox_target API](https://github.com/overextended/ox_target/blob/bf03d52c09cb5f677ac063531740fddcb51ca7cf/client/api.lua)、[oxmysql exports](https://github.com/overextended/oxmysql/blob/030d3bda11098fc4a78f1940545b674c374daa45/src/index.ts)。

## 10. SQL 分类与确认绑定

### 10.1 保守只读子集

只有 query/single/scalar/prepare/rawExecute 且 SQL 满足全部条件时免确认：AST 解析成功、恰好一条 SELECT、全树只有允许的 SELECT/表达式节点，无 INTO、锁定读、变量赋值、用户变量、动态语句、存储函数、未知 hint 或版本可执行注释。子查询递归检查。

函数仅允许清单内无副作用内建函数：COUNT、SUM、AVG、MIN、MAX、COALESCE、IFNULL、NULLIF、LOWER、UPPER、LENGTH、CHAR_LENGTH、ABS、ROUND、NOW、CURRENT_TIMESTAMP。带 schema 的函数名、未知函数、CTE、SHOW/EXPLAIN 等首版未纳入的形式均请求确认，不当作语法失败而擅自改 SQL。

不将参数字符串拼成 SQL 后执行；AST 检查原 SQL，参数保持绑定值。注释包含 /*! 或 /*+ 时进入确认；分号判断交 parser/tokenizer，不能误判字符串内分号。INSERT/UPDATE/DELETE/DDL、所有 transaction 总是确认。parser 不识别 SQL 仍可经确认后交 oxmysql 处理。

该分类是减少只读操作确认次数的产品机制，不是数据库权限替代。SQL 方言、视图和数据库扩展可能隐藏行为，清单外一律确认。通用片段/exports 和 ESX/QBCore 不应用该确认策略。

### 10.2 确认内容与协议

broker 生成 approvalId，并对规范化后的 method、原 SQL、全部参数、serverEpoch、bridgeEpoch、entrySessionId 与 OS 用户凭据身份计算请求摘要。原文本 SQL 保持原样用于展示与执行，规范化只用于稳定序列化摘要。只接受该 entry 连接对该 approvalId 的一次结果，核验摘要和生命周期；批准不持久化。

entry 在仍挂起的原始工具请求上下文中调用 elicitation/create，使用 form 模式；message 包含完整调用与参数，requestedSchema 为仅含 confirm:boolean、默认 false 的对象。只有 action=accept 且 confirm=true 才发送批准结果。decline/cancel/超时/断线均不执行，用户未明确选择不视为同意。

兼容协商依据 SDK 支持的协议版本和客户端 elicitation 能力；对于 2025-11-25 检查 form 能力，旧协议按其能力声明处理。没有 form 或只能 URL 模式时返回 APPROVAL_UNSUPPORTED，不增加网站来兜底。确认展示最多 32 KiB；超限不截断批准，提示拆分事务或参数。

普通工具输入不含 approvalId/approved 字段。entry 的 approval.result 是内部鉴权消息，不向 AI 暴露可调用工具。同机恶意进程、被控制的 MCP 客户端或任意代码执行并不在“防 AI 参数绕过”的保证范围内。

队首执行前再次比较目标 epoch 与确认摘要；期间服务器或桥接重启则请求失效，返回目标变化，由调用者重新提交和确认，不自动弹第二次对话。oxmysql 资源重启也使已确认待执行请求失效，需将该资源 generation 纳入摘要。

依据：[MCP elicitation 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)。本阶段没有验证三种客户端的 UI 是否完整显示 32 KiB；若实际更低，以该客户端可可靠展示上限拒绝过大确认。

## 11. 资源控制

读取通过 Server 桥接控制通道调用 GetNumResources/GetResourceByFindIndex/GetResourceState，返回 source=live 或缓存标记；不进入运行 FIFO。Server 不响应时不可将缓存误标 live。

变更使用 StartResource/StopResource。restart 是同一任务下的 stop → 等待 stopped → start → 等待 started，不能拆成两个任务让其他请求插队。每阶段通过状态检查和资源事件交叉观测；started 只代表生命周期，不保证客户端/NUI/数据库业务就绪。

停止失败时终止任务并报告实际状态；到期仍 starting/stopping 则 unknown，不能以 native 布尔返回推定停止完成。桥接自己通过 GetCurrentResourceName 防护，stop/restart 均报 SELF_RESOURCE_PROTECTED。不执行控制台任意命令，不自动处理依赖树、不自动重试。

## 12. 日志采集和查询

### 12.1 Server

Server Lua 使用 RegisterConsoleListener(channel,message) 采集全部控制台消息，在桥接端以流序号分批发送。每批最多 100 条、每 100 ms 刷新；传输背压时保留有界缓冲、增加 droppedCount，不能阻塞结果消息。无新 AI broker 时不无限保存日志。

频道明确解析 script:<resource> 或 c-scripting-<resource> 等已在 fixture 验证的格式；不识别的频道保留原值、resource=null。message 多行拆行，每行继承该回调频道；ANSI 从 cleanMessage 清除，原串在 includeRaw 时返回。Server 起始监听之前记录 coverageStart 和 startupGap=true，不声称完整启动历史。

### 12.2 Client 文件定位

Server 给当前 clientEpoch 发随机 logMarker，Client 输出固定前缀 FIVEAI_MCP_SESSION 加 marker、serverId、clientEpoch；marker 不作为鉴权令牌。broker 只在配置的日志目录内扫描 CitizenFX_log_*.log，扫描当前连接建立附近新建/更新的文件并按 marker 精确匹配。

发现唯一文件后记录真实路径、文件标识、起始偏移与 parser 状态；持续 tail，从日志内当前运行会话的边界读起。一个文件出现多个活跃 clientEpoch 且行内没有可验证进程分隔时，返回 LOG_MAPPING_FAILED，不把整文件分配给多个客户端。FxDK 合并日志必须通过实机证明能区分；没有证明就不能宣称支持多客户端精确归属。

文件轮转、新运行文件、截断或标识改变时重新定位；不按最近修改文件自动迁移。文件历史内容不任意回溯到其他启动会话。局部读取范围限制在当前日志文件；只读取日志，不开放任意路径工具。

### 12.3 解析与去重

逐字节流式 UTF-8 解码，跨块保留未完成字符/行，处理 CRLF/LF。资源名仅取明确结构字段；例子中正文的 vMenuClient 不能映射为 vMenu。FxDK 的 [FXSERVER STDOUT] 片段建立独立续接状态，仅对有明确 Server 转发标记的行归为 forwarded-server 并排除重复 Server 展示，不按消息文本去重。

结构化记录字段为 logId、source(server/client/forwarded-server)、streamId、sequence、clientEpoch?、observedAt、sourceTime?、channel?、resource?、message、raw?、truncated。sourceTime 不可获取时为空，不用 observedAt 假装原发生时间。

查询在当前内存窗口上应用 side/client/resource/prefix/contains 的 AND 过滤，取最后 N 条，再按采集顺序升序显示。响应含 matchedReturned、effectiveLimit、orderBy=observedAt、coverageStart、droppedCount、sourceGaps 和 truncated；单响应达字节上限时保留最新可容纳行并标记截断。

来源：[RegisterConsoleListener](https://github.com/citizenfx/fivem/blob/0d8a2a6f78a9922445d8930305af82a7b1826980/ext/native-decls/RegisterConsoleListener.md)。Client 不使用这个 Server native。所有解析规则须由脱敏真实 fixture 支撑，不能凭推测扩展频道格式。

## 13. 本地资料与官方回退

本地资料记录 schema：id、category、name、aliases、nativeHash?、side、signature?、parameters、returns?、summary、sourceUrl、sourceRevision、license、datasetVersion。按精确 hash/名称、别名、名称前缀、正文 token 的顺序排序，稳定按 id 打破同分；不需要嵌入向量服务。

构建时从人工核实清单生成资料包；旧 PHP 数组不能不经核对直接纳入。数据规模不在本 RFC 虚构承诺，发布验收列出实际条目数与来源。构建期允许更新资料，运行期线上结果不持久化。

本地筛选后零匹配才回退官方查询：native 优先官方 Native 数据集；event/guide 通过官方 citizenfx/fivem-docs GitHub 仓库树定位 content 下的 Markdown，再获取匹配文档。运行期不依赖第三方搜索引擎 key，也不假定有未公开官方全文搜索 API。

在线访问只允许 docs.fivem.net、runtime.fivem.net、api.github.com 对指定 citizenfx 仓库的路径及对应 raw.githubusercontent.com 路径；重定向逐跳校验。限制一次请求树清单不超过 2 MiB、最多读取 5 个匹配文档、总时间 8 秒。Native 全量数据超预算时不无限下载，返回线上查询不可用及官方检索链接。先按文件名与已知索引定位，在线关键词搜索不承诺覆盖所有正文。

在线数据只留本次请求内存，完成后释放。GitHub 无鉴权限流时返回 rate_limited 与本地结果状态；本轮研究已实际遇到 GitHub REST 未鉴权限流，所以不能把官方回退当作离线资料不完整的无限兜底。链接仍返回给 AI，可用自己的浏览器进一步查阅。

## 14. Skills 和截图禁用契约

fivem-mcp Skill 的入口只描述工具选择与边界，详细安装、错误码、Lua/TS 示例、资源控制、数据库确认和恢复分别放自身 references。ESX/QBCore/ox 的方法清单从 adapters 数据生成到各自 Skill 内，并标记“适配支持”与“通用知识”的区别。

NUI Skill 指导使用用户已有 Chrome DevTools MCP 的发现、页面选择、DOM/console/network 调试能力；不假设具体 tool name 在所有版本一样，先读取该连接提供的工具声明。FxDK nui_toolkit 的实际入口和普通 FiveM 调试目标分别实测后写入，不创建本 MCP 的 CDT 通道。

截图仅有 ScreenshotRequest(clientId,delayMs=0)、ScreenshotResult(path,width,height,clientId) 类型和常量 implemented=false、enabled=false。无 handler、路由、捕获后端、图片写入、原生依赖、开关启用路径。未来实现必须另行评审；本期 tools/list 严格排除 screenshot。

## 15. 替代方案与风险

| 决策 | 未采用路线 | 取舍 |
|---|---|---|
| 共享 broker | 每 stdio 自己直接连 FiveM | 共享队列和单服务器身份需要集中协调；代价是生命周期与恢复存储 |
| WebSocket | HTTP 长轮询 | 结果、日志和心跳统一；代价是重连和背压管理 |
| Server 中转 Client | Client 用 NUI 直连 | 降低 NUI 依赖，保留 source 校验；代价是桥接 Server 成为单点 |
| 显式框架方法清单 | 任意路径反射调用 | 可验证参数/回调/返回；代价是首版覆盖有限，片段补足 |
| 未知状态暂停 | 自动重试或超时强制推进 | 避免重复副作用；代价是无法证明终态时可能长期暂停 |
| 文件日志 | 客户端伪造控制台监听能力 | 利用已有日志文件；代价是来源归属不完整且 FxDK 映射需验证 |

| 风险 | 检测/缓解 | 结论 |
|---|---|---|
| Client JS/跨 Lua JS 异步与 exports 行为差异 | 双端 Promise/协程和错误 fixture 实机测试 | 是发布门槛 |
| FxDK 多客户端日志混合且不能区分 | 唯一标记+原进程字段验证 | 不猜测，失败需替代路线评审 |
| 未知任务丢失终态 | write-ahead 恢复记录、远端未 ack 结果缓存 | 不自动重试；通用任务可能不能恢复 |
| 任意片段修改全局或调用有副作用 API | 明确调试信任边界、只在 MCP 资源分派 | 不承诺沙箱；本地文件修改不是工具能力 |
| UI 等待阻塞 FIFO | 完成边界、超时提示、游戏内取消 | 接受全局串行约束 |
| 客户端确认能力缺失/显示不全 | 能力协商和三客户端实测 | 需要确认的操作不执行 |
| 框架方法或返回结构漂移 | 固定源码基线、adapter probe、投影测试 | 不静默把不支持方法当成功 |
| 官方资料限流 | 随包资料优先、有限网络预算 | 在线回退允许失败，明确说明 |
| 本机进程冒充 | 双角色凭据、loopback、身份/epoch 校验 | 不防当前用户权限已被完全控制 |

## 16. 验证、落地与回退

### 16.1 落地顺序

1. 新建模块和类型契约，实现入口、broker 启动互斥、身份握手、退出和恢复存储；用假桥接做进程级测试。
2. 在已获操作授权的 FxDK/FXServer 环境验证双端 Lua/JS 片段、跨语言异步结果、客户端会话与日志唯一标记。若不可行，先修订相关路线，停止向后堆功能。
3. 实现全局 FIFO、超时、终态缓存、迟到结果和重连对账；运行故障注入测试。
4. 加入资源控制、日志查询与首版框架适配；用测试资源和测试数据库验证读写与确认。
5. 接入本地资料、官方回退和 Skills；分别准备三种客户端 stdio 配置，执行发布包内路径验证。

此顺序是依赖顺序，不是提交清单。任务分工在实施阶段按模块指派；当前未指定团队成员，不虚构负责人。

### 16.2 自动化与故障注入

- 启动 10 个入口竞争，断开部分和全部入口，检查只有一个 broker、宽限期复用与退出。
- 在恢复记录写入前、写入后发送前、发送后 received 前、终态收到后 ack 前分别模拟进程崩溃，验证无重复执行。
- 多入口交错提交 Server/Client/框架/资源操作，确认序号、取消与数据库批准的入队时刻。
- 同 serverId 换 clientEpoch、Server 重启、桥接单独重启、跨会话回报、重复/篡改结果，验证不会误完成任务。
- Lua 多返回/尾 nil、JS undefined/BigInt、vector、循环对象、过大结果、无响应和脱离等待后台任务分别验证。
- SQL fixture 覆盖注释/字符串内分号、CTE、锁、赋值、函数、事务、parser 不支持语法、改变已批准参数、确认超时及断线。
- 真实日志脱敏 fixture 覆盖跨块 UTF-8、ANSI、FxDK 转发、重复正文、未知资源、文件轮转和多个客户端 marker 冲突。
- MCP 协议检查仅 10 tools，没有 screenshot/文件工具/旧 Prompts/Resources。测试不要求执行 code snippets 的人工批准。
- 根插件验证继续通过，现有 Skill 测试不被新模块目录污染；发布包运行不依赖开发源码绝对路径。

### 16.3 实机证据矩阵

每条记录环境版本、资源 commit、AI 客户端版本、输入、实际输出、日志证据及 PASS/FAIL/NOT_EXECUTED。当前以下全部 NOT_EXECUTED：

| 环境 | 验收 |
|---|---|
| FxDK | 双端 Lua/TS、资源控制、日志映射与筛选、断线/超时恢复 |
| 直接 FXServer | 同上，验证不会依赖 FxDK 才有的日志转发 |
| 多客户端 | server ID 重用、目标隔离、多文件或共享文件来源识别 |
| ESX、QBCore 各自测试环境 | 首版清单所有方法、玩家快照、目标离线和资源重启 |
| ox_lib、ox_target、oxmysql | UI 完成/取消、资源归属、只读/写入/事务确认与结果 |
| Codex / Claude / CodeBuddy | stdio 启动、工具发现、20 秒任务返回后查询、elicitation 正常和不支持路径 |
| NUI Skill | 两种宿主下找到正确 CDT 目标、读取 console 与 DOM；不通过本 MCP 实现 |

### 16.4 发布与回退

先交付本机开发使用版本，不部署到社区服务器。发布前保留原配置备份，由本地 AI/用户安装桥接并修改启动配置。MCP 本身不执行安装覆盖。协议版本变化要求所有 AI 会话退出后配套更新桌面与桥接；不在旧任务未知时热切换协议或清空恢复记录。

回退时关闭 AI 入口、等待 broker 退出，由本地 AI/用户恢复旧入口路径与桥接版本。旧版遇到不能识别的 recovery schema 必须拒绝执行，不能删记录。资源内和数据库已经发生的副作用不会因包版本回退自动撤销；数据恢复属于用户的外部操作，不伪造 rollback 成功。

## 17. 评审结论与可行性门槛

产品范围已经确认，本文没有新的产品偏好问题，也没有占位值。接口、默认限制和方法清单可直接用于开发；以下是必须用证据解决的发布门槛，不是已验证能力：

1. FxDK/普通客户端的日志标记能否可靠映射，尤其共享日志的多客户端情况；实施连接阶段验证，不成立则回到日志路线评审。
2. FiveM 双端 JS/Lua 异步和库 exports 等待是否符合该构建基线；执行闭环阶段验证，不成立则收敛适配实现，不能跳过等待。
3. 三种 MCP 客户端 form elicitation 能力和完整展示；客户端集成阶段验证，不支持则明确关闭需确认调用，不绕过用户确认。
4. 任意片段未知终态丢失后无法普遍证明安全恢复；这是本 RFC 显式接受的限制，不以自动重连或人工删除状态文件掩盖。

当前只交付 RFC。已确认设计保持原样；没有实现代码、安装依赖、启动 FiveM、修改其他资源文件、提交、推送或发布。
