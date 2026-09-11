# FiveM MCP 实现质量、完成度与下一步开发审查

审查日期：2026-09-09。范围：`D:\Exre\ex-fiveai\mcp` 当前全量源码、测试及构建产物，对照本目录的设计、RFC 和两份历史报告。基线：`d8d84c05d6c41896a3e7ef44a3ba929144db8313`；审查前 `mcp/` 无未提交改动，根目录已有未跟踪 `skills-lock.json`。本轮只新增本报告，不修复实现、不修改原设计。

## Findings

共 **4 项：P0 0、P1 2、P2 2、P3 0**。F1 是相对完整方案的交付缺口；F2–F4 是现有契约中可复现的问题。运行服务尚不存在，以下不代表已发生线上攻击或任务误执行。

### F1 · [P1] 完整方案交付缺口：构建产物仍不能作为 MCP 服务连接

位置：[index.ts:1](D:/Exre/ex-fiveai/mcp/src/index.ts:1)、[registry.ts:14](D:/Exre/ex-fiveai/mcp/src/tools/registry.ts:14)、[package.json:11](D:/Exre/ex-fiveai/mcp/package.json:11)。

入口只导出类型、schema、常量及纯函数。`REGISTERED_TOOLS = ["status"]` 是一个列表，没有实际 MCP 注册或 status handler。依赖只有 Zod，没有 stdio transport、MCP SDK、Fastify、WebSocket 服务或 FiveM 桥接资源。

本轮重新构建后，向 `node mcp/dist/index.mjs` 的标准输入发送 JSON-RPC `initialize`（协议版本 `2025-11-25`），进程返回 `exit=0, stdout="", stderr=""`，未回复初始化。不是客户端配置问题，而是产物没有协议处理循环。

设计 §4 要求十个可用工具，RFC §16.1 第一步还包含入口、broker 启动互斥、身份握手、退出和恢复存储。当前只完成其中的契约基础，第一步整体尚未完成。包和入口已明确标注 contracts-only，因此这是相对用户要求的完成度判断，不是将既定切片范围误判为实现回归。

最小开发方向：接通 stdio → broker → 假桥接的进程链路，先提供真实 status，再逐项接入功能；用真实子进程验证 initialize、tools/list、tools/call。不要仅修改注册数组来宣称补齐工具。

### F2 · [P1] failed 仍接受没有完成证据的执行，状态查询也未复用错误阶段约束

位置：[messages.ts:227](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:227)、[messages.ts:321](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:321)；测试：[messages.test.ts:288](D:/Exre/ex-fiveai/mcp/tests/messages.test.ts:288)。

`TaskResultSchema` 只特殊检查未知错误码、编译错误、序列化错误。普通 `EXECUTION_ERROR` 携带 `executionCompleted=false, noRemoteExecution=false` 时仍被接受为 failed 终态；现有测试第 294–295 行明确断言这个反例应通过。

同时，`TaskStatusResultSchema` 的 failed 分支只要求 error/evidence 同时出现并排除两个 unknown 错误码，没有检查完成证据与错误阶段。以下是本轮实测结果：

| error.code；evidence 均为 false/false | task.result | task.statusResult（failed、resultAvailable=true） |
|---|---|---|
| EXECUTION_ERROR | 接受 | 接受 |
| RESULT_TOO_LARGE | 拒绝 | 接受 |
| COMPILATION_ERROR | 拒绝 | 接受 |

RFC §8 要求执行器能报告函数结束后才发终态；§7.4 将身份匹配的 failed 作为解除暂停的依据。false/false 既不证明远端结束，也不证明从未执行，不能承载这种终态含义。重连状态查询路径还可能接受直接结果路径拒绝的证据。如果调度器按契约消费 failed，会存在过早推进的风险；本轮没有运行中的调度器可用于证明实际误推进。

最小修复：抽取所有 failed 分支共享的证据校验，明确执行错误、下发前失败和序列化失败的合法组合；没有结束/未执行证据的报告不能成为 verified terminal。修正上述测试，并让同一个错误阶段矩阵覆盖直接结果与状态查询。调度器落地时补“无证据结果不发 resultAck、不清 pending、不启动下一任务”的集成测试。

历史报告对旧 F3 的修复解决了 unknown 错误码和字段缺失，但“全部闭合”的结论不覆盖本次反例。

### F3 · [P2] 内部消息对完整工具输入重用 args 限额，拒绝公共层合法的边界参数

位置：[messages.ts:23](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:23)、[messages.ts:107](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:107)、[messages.ts:135](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:135)；公共层：[schemas.ts:149](D:/Exre/ex-fiveai/mcp/src/tools/schemas.ts:149)。

公共 Execute schema 对 `input.args` 单独施加 32 层、10,000 节点限制；内部 `BoundedArgumentsSchema` 却把同样预算用于包含 side、code、args、timeoutMs 的整个工具输入。外层包装多算一层和若干节点，因此公共层合法的最大输入无法经过 task.submit/task.dispatch。

复现（在 mcp 目录以 Node ESM 执行）：

```js
import { ExecuteLuaInputSchema, TaskSubmitSchema } from './src/index.ts';
let args = 0;
for (let i = 0; i < 32; i++) args = [args];
const input = ExecuteLuaInputSchema.parse({ side: 'server', code: 'return args', args });
console.log(TaskSubmitSchema.safeParse({
  tool: 'execute_lua', arguments: input,
  requestId: '123e4567-e89b-42d3-a456-426614174000',
}).success); // false；公共 parse 已成功
```

最小修复：区分业务 args 限额与消息包装限额；保留递归前防护，再按工具 schema 校验实际 args。不要简单取消内部深度检查。增加 public parse → submit → dispatch 的组合测试，覆盖深度 31/32/33 和节点上限，而不只独立测试每个校验器。

### F4 · [P2] 生成的框架/ox 工具 JSON Schema 丢失了 args 必须为数组的基本契约

位置：[json-bounds.ts:142](D:/Exre/ex-fiveai/mcp/src/protocol/json-bounds.ts:142)、[schemas.ts:217](D:/Exre/ex-fiveai/mcp/src/tools/schemas.ts:217)、[schemas.ts:318](D:/Exre/ex-fiveai/mcp/src/tools/schemas.ts:318)；测试：[registry.test.ts:49](D:/Exre/ex-fiveai/mcp/tests/registry.test.ts:49)。

`boundedJsonArray` 用 `z.custom` 表达整个数组，生成时用 `unrepresentable: "any"` 降级。实测 `toolInputJsonSchema('esx'/'qbcore'/'ox').properties.args` 均只有 `{"default":[]}`，没有 `type:"array"`。发布 schema 接受对象或字符串，实际工具 schema 会拒绝。

这不只是字节限额或动态目标规则无法表达：数组类型本身完全可以由 JSON Schema 表达。AI 客户端按工具声明构造参数时得不到位置参数数组的约束。现有测试主要断言“可生成 object”及 status 的 strict 性，没有验证这些字段的形状。

历史加固报告已记录该降级并将其视为非阻塞限制；本轮依据 RFC §6.1 的明确数组契约将其列为 P2，建议在注册这些工具前修复。

最小修复：让迭代防护与可描述的数组 schema 组合，或使用同一声明的明确 JSON Schema 映射，保留数组类型；确保深层输入仍先经过迭代限额检查。测试生成 schema 的 args 类型，并核对合法数组、对象和字符串与运行时校验的一致性。

## 设计与 RFC 完成度

完成度以当前代码为证据；文档中的“未实施”属于历史状态，不能单独用来判断当前实现。没有用文件数或 88 项测试计算虚假的功能百分比。

| 要求 | 当前状态 | 具体证据或缺口 |
|---|---|---|
| ESM 包、固定依赖、类型检查与构建 | 已具备基础 | mcp/package.json、lock、tsconfig、esbuild；根已有 test:mcp |
| 十工具输入、内部消息、错误、身份与容量 | 部分完成 | 十组输入、20 种消息；仍有 F2–F4；没有完整业务输出和运行路由实现 |
| stdio、十工具实际可调用 | 未实现 | initialize 无响应；status 也没有 handler |
| 单 broker、用户 SID 启动/lifetime pipe、配置摘要 | 未实现 | runtime/config 只有 schema，没有进程、互斥与发现实现 |
| 角色令牌、Host/Origin、回环监听、会话租约 | 未实现 | 配置 host 校验不等于网络鉴权或活跃会话验证 |
| Server/Client 桥接与事件 source 校验 | 未实现 | 没有 resources/fiveai-mcp 资源及 fxmanifest/Lua/JS 桥接 |
| Lua/TS 执行、AST 约束、source map、跨语言编码 | 未实现 | WireValue 格式存在，编码器/解码器与执行器不存在 |
| FIFO、取消、超时 unknown、迟到结果和去重 | 未实现 | 只有状态和消息定义，没有调度器或故障注入测试 |
| write-ahead 恢复存储、安全重启对账 | 部分契约 | 原执行身份和 matchesDispatchIntent 已补；没有原子写、flush、ack 顺序和恢复调度 |
| ESX/QBCore/ox 首版方法和玩家快照 | 未实现 | 通用入参不能替代方法清单、参数映射、版本探测和适配调用 |
| oxmysql SQL AST 与原用户 elicitation | 未实现 | 有 approval 消息，没有分类、完整事务展示、摘要/代际复核及一次性批准生命周期 |
| 资源读写与桥接自身保护 | 部分契约 | list/status 控制消息已补；没有 native 调用、stop/start 阶段观测或自身保护逻辑 |
| Server 日志、Client marker 映射、tail 和查询 | 未实现 | 只有日志 record/查询参数；无 collector、真实 fixture、轮转及来源判断 |
| 本地资料与受限官方回退 | 未实现 | 没有资料包、索引、排序、联网白名单和预算实现 |
| MCP 安装/恢复 Skill、NUI/CDT 工作流、ox-target | 未实现 | 当前九个通用 Skill 不能替代新增工作流与生成的方法清单 |
| 发布包与 Codex/Claude/CodeBuddy 接入 | 未实现 | 根 files 仍只有 skills、cordis.patch.yml；没有桌面入口与桥接的打包验收 |
| 截图禁用 | 已完成本切片契约 | 两个 false 常量、请求/结果类型；没有捕获依赖；真实 tools/list 排除待接线验证 |

**没有完成 notes/fivem-mcp 的整体内容。RFC §16.1 第一步仅完成契约子部分，其余运行能力还未落地。**

截图捕获、网站、文件读写工具、旧 Prompts/Resources、模板生成和 CDT 代理均是明确排除项，不应作为功能缺失去补。现有其他通用 Skills 被保留符合 RFC。

## 实现质量与安全判断

现有契约层具备可继续使用的基础：strict 输入、集中限制、精确依赖、带标签的跨语言值格式、迭代深度防护以及独立的身份匹配函数。源码没有通过 any 或 ts-ignore 大量绕过类型检查。主要问题集中在跨消息语义和边界组合，单个 schema 的通过率不能代替端到端一致性。

旧报告 F2（身份持久化）、F4（资源读取路由）、F5（深层输入栈溢出防护）、F6（bytes 长度一致性）的修复在当前源码和测试中存在；本次没有将这些原问题重复列为未修复。F2、F3 是进一步核查后发现的终态残留问题和新边界不一致。

没有足够证据宣称当前存在可从游戏客户端利用的远程执行、令牌泄漏、SQL 批准绕过或路径穿越漏洞：网络、桥接、SQL 和文件运行路径尚未实现。相应安全保证也尚未实现，不能标成通过。后续必须测试角色鉴权、来源绑定、重复任务、原子恢复、原始确认会话、oxmysql generation、日志真实路径归属及在线重定向白名单。通用 Lua/JS 本来就是受信任本机调试能力，设计明确不提供任意代码安全沙箱。

## 测试意图与验证结果

| 本轮检查 | 结果 | 能证明什么 |
|---|---|---|
| Node 环境 | v22.22.1 | 本轮实际测试版本；未验证其他补丁版本 |
| mcp `npm test` | PASS：typecheck + 88/88 | 当前契约与纯函数用例通过 |
| mcp `npm run build` | PASS：748.3 KiB ESM | 契约包可构建，不代表服务可启动 |
| 根 `npm test` | PASS：11/11 | 插件验证行为未受影响 |
| 根 `npm run validate` | PASS：9 skills | 现有 Skills/metadata 合法 |
| MCP initialize 子进程探测 | FAIL：无响应，退出码 0 | 当前产物不可连接；符合 F1 |
| F2/F3/F4 补充探针 | 缺陷已复现 | 原有绿灯测试没有覆盖这些跨层契约 |
| skill 静态扫描 | PASS（UTF-8 重跑） | 29 个 TS/JS 文件；0 显式 any、0 ts-ignore；不构成安全审计证明 |
| 实际 FiveM/FxDK、数据库、三 AI 客户端 | NOT_EXECUTED | 没有真实宿主功能验收 |
| 远端 CI、required checks、review threads | NOT_EXECUTED | 本地全量 review，未指定 PR/MR；不提供合并批准 |

静态扫描第一次因 Windows 默认 GBK 不能输出 emoji 失败，使用 `py -3 -X utf8` 重跑成功。其危险调用命中为 `RegExp.exec`，不是进程执行；超长函数列表包含 if/for 块的误识别，不作为 finding。npm 的 email 配置弃用提醒未影响测试。

当前单测适合身份、解析和格式，尚不适合证明进程与宿主行为。应优先修正 F2 中错误的预期，补齐 F3 的公共输入到内部消息组合测试和 F4 的生成 schema 契约测试。之后分阶段增加真实 stdio/WS、进程崩溃、FiveM 与 elicitation 测试，不能用 mock 掉这些边界的单测替代验收。

## 下一步开发步骤

按依赖推进，每一步都有独立验收门槛。本轮只给步骤，没有实施这些功能。

1. **收敛契约残留问题。** 修复 F2–F4；统一 failed 证据验证、输入包装预算和 JSON Schema 数组形状。验收：补充反例得到正确拒绝/接受，原有 88 项、构建与根插件校验继续通过。不要把后续缺失子系统一起塞进修复。

2. **完成 RFC 第一步剩余部分：可连接的入口与单 broker。** 新增 cli/broker、配置与凭据加载、用户 SID 对应的 startup/lifetime pipe、鉴权握手、心跳、30 秒宽限期和 recovery 原子存储。先接通真实 status 与假桥接，注册表只暴露实际可服务能力。验收：10 个入口竞争只有一个 broker；不同配置不能产生第二调度器；错误 token/role/Host/Origin 被拒绝；入口异常退出能被清理；损坏或写入失败的恢复记录阻止下发；真实 stdio initialize/tools/list/tools/call 可用。

3. **尽早验证 FiveM 路线可行性。** 新建专用资源及分开的 Server/Client 构建，完成双端 Lua/JS 最小异步闭环、TS 转换、原运行时编码、clientEpoch 和 source 验证；验证日志 marker 能映射到正确客户端文件。验收：分别在 FxDK 和直接 FXServer 留下版本、输入、输出证据；覆盖 await/Citizen.Await、Lua 尾 nil、JS undefined、跨语言错误和 server ID 重用。共享日志无法可靠归属或异步路线不成立时，先调整方案再继续增加适配功能。

4. **实现全局 FIFO 与故障恢复。** 覆盖所有执行类操作，加入 20 秒等待返回、排队取消、unknown 暂停、迟到终态、未 ack 结果缓存和无重放对账。验收：在写意图前后、发送前后、received 前、结果收到后 ack 前注入崩溃；验证一次副作用、不因重连重发、无证据不推进、读取与控制通道不被暂停队列堵住。不得提供 force 或删恢复文件的替代流程。

5. **加入资源控制、日志与框架能力。** 资源 restart 保持一个任务中的 stop→观察→start，保护实际桥接资源名；日志补真实脱敏 fixture、UTF-8 分块、轮转、重复来源及容量测试；方法清单按 RFC 固定基线实现 ESX/QBCore/ox 的执行端约束、参数映射及快照。验收：首版清单逐方法测试，资源重启重新解析，离线/不存在/不支持分别报错，FIFO 暂停时读控制通道仍响应。

6. **单独闭合 oxmysql 确认链。** 实现保守 SELECT AST 清单、完整事务展示、原 entry 的 elicitation、摘要与目标/oxmysql generation 绑定、一次消费和确认后入队。验收：未知 SQL 总是确认；改 SQL/参数/目标失效；拒绝、取消、超时、断线和不支持 form 均不执行；在专用测试数据库验证写入只发生一次且不伪称超时回滚。

7. **补齐资料、Skills 与发布验收。** 加入有来源/版本的本地资料和有预算的官方回退；生成各框架方法参考，新增安装/恢复与 NUI/CDT 指引；根构建和发布清单携带桌面产物及桥接。验收：离线 reference 可用，重定向/限流处理正确；从实际发布包解包后启动，不依赖开发绝对路径；Codex、Claude、CodeBuddy 分别完成 stdio 与 elicitation 验证；最终 tools/list 恰好十个并排除截图、文件工具及旧协议资源。

**建议紧接着做第 1 步，然后交付第 2 步的可连接进程闭环。** 第 3 步的宿主验证应早于大规模框架适配开发，避免在未经验证的执行与日志路线之上堆功能。

## Summary

当前实现是有测试基础的契约包，尚未成为可用的 FiveM MCP；整体设计未完成。存在 1 项整体交付缺口和 3 项可复现契约问题，优先处理终态证据，再完成入口/broker/恢复存储的最小运行闭环。测试与构建通过仅证明现有切片，真实宿主、确认交互和发布能力仍未验收。
