# Node.js FiveM 调试 MCP 代码审查

审查日期：2026-09-09。范围：`D:\Exre\ex-fiveai\mcp` 全量源码和测试；对照 `notes/fivem-mcp/specs/2026-09-09-nodejs-debug-mcp-design.md` 与 `notes/fivem-mcp/rfcs/nodejs-debug-mcp-rfc.md`。代码基线：`77ad47ad7ede8ef60f8b7ee3178c50abab0e680b`，分支 `master`，审查期间 `mcp/` 无工作区差异。

## Findings

共 6 项：P0 0、P1 3、P2 2、P3 1。其中 F1 是相对完整设计的交付缺口，F2–F6 是现有契约的问题。代码明确自称 contract slice，不能将尚未实施的完整产品描述为已经发生的运行时回归。

### F1 · [P1] 交付缺口：当前产物不是可连接的 MCP 服务

位置：[mcp/src/index.ts:1](D:/Exre/ex-fiveai/mcp/src/index.ts:1)、[mcp/src/tools/registry.ts:14](D:/Exre/ex-fiveai/mcp/src/tools/registry.ts:14)、[mcp/package.json:11](D:/Exre/ex-fiveai/mcp/package.json:11)。

`index.ts` 仅导出 schema、类型、常量和辅助函数；构建命令只是将这些导出打包。没有 MCP SDK、stdio transport、请求处理器、Fastify broker 或 FiveM 桥接资源。`REGISTERED_TOOLS = ["status"]` 只是常量，不是实际 MCP 注册；连 status handler 也不存在。

复现：向 `node mcp/dist/index.mjs` 的 stdin 发送合法 JSON-RPC `initialize` 请求，子进程退出码为 0，stdout/stderr 均为空，没有初始化响应。源码清单中不存在 `cli/`、`broker/`、`scheduler/`、执行实现或 `resources/fiveai-mcp/`。

设计 §4 要求 10 个实际工具；RFC §16.1 第一步还要求入口、启动互斥、握手、退出、恢复存储和假桥接进程测试。因此当前连第一个落地步骤都只完成了其中的类型契约部分，不能作为完整 MCP 交付。

修复方向：先明确标识为契约包；按 RFC 接通 stdio → broker → 假桥接的最小链路，加入真实子进程 initialize/tools/list/tools/call 测试，再实施后续能力。截图、网站、文件修改工具不应为补齐数量而加入。

### F2 · [P1] 恢复记录没有保存 Server/桥接的原始目标身份

位置：[mcp/src/protocol/recovery.ts:24](D:/Exre/ex-fiveai/mcp/src/protocol/recovery.ts:24)、[mcp/src/protocol/messages.ts:33](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:33)。

`DispatchIntentRecordSchema` 保存的 target 对 Server 只能是 `{side:"server"}`；没有旧 Server 进程创建时间、PID 或可关联的服务器运行身份，也没有 bridgeEpoch。代码注释明确将桥接身份留给重连后的鉴权连接，而不是持久化。strict schema 又会拒绝把这些身份直接加入 target。

broker 重启后，当前已鉴权连接只能证明“现在是谁”，不能还原未解决任务原来属于哪个 Server/桥接实例。`originalBrokerInstanceId` 只标识桌面 broker，不能替代旧执行环境身份。尤其 RFC §7.4 的资源生命周期恢复例外要求证明旧 Server 已退出，并核实新 Server 身份；当前记录缺少完成这项比较的证据。

复现：没有任何 Server generation 的 resource dispatch intent 校验通过；补充 serverPid/serverStartedAt/bridgeEpoch 后被拒绝。`recovery.test.ts:21` 还将没有这些字段的样例称为 full target binding，未测试真正跨重启匹配。

修复方向：在下发记录和相关结果/握手契约中定义并保存完整的原始目标身份及可验证性，区分服务器进程、桥接实例和客户端会话。补充 broker 重启后接入另一 Server、桥接单独重启、PID 重用、迟到结果的匹配测试。当前未实现恢复调度，所以这里是安全恢复契约缺陷，不是已实测的任务误执行。

### F3 · [P1] 终态 schema 接受“执行结果未知”，并丢失完成证据字段

位置：[mcp/src/protocol/messages.ts:158](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:158)、[mcp/src/protocol/messages.ts:183](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:183)；错误测试：[mcp/tests/messages.test.ts:158](D:/Exre/ex-fiveai/mcp/tests/messages.test.ts:158)。

`TaskResultSchema` 的 failed 分支允许所有 StructuredError，包括 TIMEOUT_UNKNOWN 和 CONNECTION_LOST_UNKNOWN。即使 error 明确带 `sideEffectsUnknown=true`，也仍然被包装成“已验证终态”。现有测试甚至显式要求 CONNECTION_LOST_UNKNOWN 作为 failed 通过。

RFC §7.4 允许原执行器的明确终态解除队列阻塞，而超时/断线不能证明函数结束。若后续调度器按该契约消费结果，会把未知执行误当可推进的失败。与此同时，RFC §6.3/§8 要求的 `executionCompleted`、`noRemoteExecution` 没有对应字段；带 `executionCompleted:true` 的序列化失败报告被 strict schema 拒绝。

`TaskStatusResultSchema` 也只检查 result/error 二选一，没有状态关联：`state:"succeeded", resultAvailable:true, error:TIMEOUT_UNKNOWN` 实测通过。查询客户端无法依靠已校验结果判断真实终态。

修复方向：拆分明确终态与 broker 观测未知状态，终态分支禁止未知执行错误；按错误阶段建模完成证据。status 以状态为判别约束 result/error/resultAvailable 的组合。替换当前错误 fixture，覆盖未知结果不能变成终态、序列化失败已结束、编译失败从未下发，以及状态/结果矛盾的拒绝路径。

### F4 · [P2] 合法 resource.list/status 没有任何可用的内部请求路由

位置：[mcp/src/protocol/tool-names.ts:30](D:/Exre/ex-fiveai/mcp/src/protocol/tool-names.ts:30)、[mcp/src/protocol/messages.ts:85](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:85)、[mcp/src/protocol/messages.ts:292](D:/Exre/ex-fiveai/mcp/src/protocol/messages.ts:292)。

公共 ResourceInputSchema 接受 list/status，task.submit 明确拒绝这些读取；control.request 的 tool 枚举又完全排除 resource。task.dispatch 同样拒绝资源读取，18 种消息中没有补充的桥接读取请求。

复现 list 与 status 两组输入均为：public=true、control=false、fifo=false。RFC §11 要求它们经 Server 控制通道读取，不受执行 FIFO 阻塞。注释将此留待 resource-control slice，说明是已知延期，但当前 v1 wire contract 仍不完整，后续不能只接 handler 就实现该功能。

修复方向：定义资源读取的 entry→broker 和 broker→bridge 请求/响应路径，按 action 限制控制通道只允许 list/status，保持资源变更进入 FIFO。测试覆盖从公共请求到桥接的完整路由，以及 FIFO 暂停时读取仍可发起。不要保留“resource 整体必须被控制通道拒绝”的测试结论。

### F5 · [P2] 小体积深层输入会使校验器抛出 RangeError

位置：[mcp/src/tools/schemas.ts:144](D:/Exre/ex-fiveai/mcp/src/tools/schemas.ts:144)、[mcp/src/protocol/wire-value.ts:59](D:/Exre/ex-fiveai/mcp/src/protocol/wire-value.ts:59)、[mcp/src/protocol/envelope.ts:141](D:/Exre/ex-fiveai/mcp/src/protocol/envelope.ts:141)。

输入先经过递归 `z.json()`，之后才检查 args 字节数；WireValueSchema 同样无限递归。深度限制只是 LIMITS 常量，wire 文件注释把限制交给尚不存在的编码器。发送端编码器限制也不能保护接收端免受错误或异常 payload 影响。

在 Node v22.22.1 实测：2,000 层 JSON 数组只有 4,001 字节，传入 ExecuteLuaInputSchema.safeParse 即抛 `RangeError: Maximum call stack size exceeded`，没有返回结构化校验失败；2,000 层 wire array 只有 54,015 字节，也产生同样异常。两者分别低于 128 KiB args 和 256 KiB 结果限制，均低于 1 MiB 帧限制。

修复方向：在递归 schema 前使用有界迭代遍历，检查深度、节点数、字节数；为输入明确深度策略，并为接收结果执行 RFC 的深度 32/元素 10,000 限制。边界函数应把拒绝转成可识别校验错误。补充小体积超深 JSON、合法深度边界和宽数组测试。

这是已复现的解析可用性缺陷；当前没有网络服务，不能据此声称存在已暴露公网的 DoS 或已经可以杀死 broker。未来接线后的影响取决于异常处理和输入边界。

### F6 · [P3] bytes 声明长度与实际数据可以矛盾

位置：[mcp/src/protocol/wire-value.ts:100](D:/Exre/ex-fiveai/mcp/src/protocol/wire-value.ts:100)、[mcp/tests/wire-value.test.ts:135](D:/Exre/ex-fiveai/mcp/tests/wire-value.test.ts:135)。

schema 只分别校验 base64 格式和非负 byteLength，不验证二者一致。`{kind:"bytes",base64:"AQID",byteLength:1000}` 校验通过，但实际只有 3 字节。现有测试仅检查正确样例、非法 base64 和负长度。

消费者会收到互相冲突的结果元数据；未来不能直接相信该长度做计量或分配。当前没有 decoder，尚无证据表明发生了错误分配。

修复方向：根据 base64 长度及 padding 计算实际字节数并比对，增加过大、过小和空内容的长度测试。

## 完成度对照

文档仍保留“尚未实施”的历史状态；本次按实际源码判断，不将文档状态当作实现证据。无需为本轮 review 改写原设计或 RFC。

| 设计 / RFC 要求 | 实际状态 | 证据与缺口 |
|---|---|---|
| 包、类型检查、构建基础 | 部分完成 | ESM、Zod、锁文件、TypeScript/esbuild 和测试命令存在；没有 MCP/WS/SQL 服务依赖或运行入口 |
| 公共工具输入与内部消息 | 部分完成 | 10 个输入 schema、18 种消息；F2–F6 表明契约尚未收敛 |
| stdio 与 10 tools | 未实现 | 导出常量不等于 tools/list；initialize 无响应，连 status 也不能实际调用 |
| 单 broker、SID pipe 互斥、心跳、退出 | 未实现 | 只有配置、发现结构和时间常量，没有进程/连接实现 |
| 角色鉴权、Host/Origin、目标会话校验 | 未实现 | loopback 配置校验不等于鉴权；没有网络升级和 source 校验路径 |
| FiveM Server/Client 桥接 | 未实现 | 没有 resources/fiveai-mcp/fxmanifest.lua 及 Lua/JS 桥接代码 |
| Lua/TS 执行、AST 限制、source map、跨语言编码 | 未实现 | wire schema 不等于编码器；无编译/执行处理器 |
| FIFO、取消、unknown 暂停、去重和恢复 | 未实现 | 状态枚举及 recovery schema 存在，无调度器、原子存储、故障恢复；F2/F3 是先行契约问题 |
| ESX/QBCore/ox 方法适配 | 未实现 | 只有通用输入 shape，无版本方法清单、逐方法参数校验、资源探测和调用映射 |
| SQL AST 与原会话 elicitation 确认 | 未实现 | 只有 approval 消息；无 SQL 分类、完整展示、摘要计算/复核、单次消费、oxmysql generation 校验 |
| 资源控制 | 未实现 | 有输入结构，无 native 调用、阶段观察、自身保护；读取路由还存在 F4 |
| Server 日志及 Client 文件映射/解析 | 未实现 | 只有查询和日志 record schema，无 collector、tail、marker 映射或真实 fixture |
| 本地资料、官方回退、网络白名单 | 未实现 | 无 data/reference、索引或有界网络请求；无游戏连接时的 reference 也不可用 |
| MCP/NUI 调试 Skill、ox-target 与方法同步 | 未实现 | 现有九个通用知识 Skill 不能替代新增安装/恢复/CDT 工作流；新路径不存在 |
| 发布包、三客户端安装配置 | 未实现 | 根包 files 仍只包括 skills 与 cordis.patch.yml，无桥接/入口发布闭环 |
| 截图禁用契约 | 已实现契约范围 | implemented/enabled=false、类型和 delay 默认常量存在，无 handler/捕获依赖；实际 tools/list 排除仍需 MCP 接线后验证 |

**结论：未完成 notes/fivem-mcp 的设计或 RFC；当前是契约基础阶段，不是可用调试服务。** 不用源码文件数或测试通过数推算功能完成百分比。RFC §16.1 的第一步仅部分完成，其余运行能力无实现。

## 实现质量与安全判断

现有纯契约层有可保留的基础：strict objects、正安全整数 ID、日历日期验证、UTF-8 code/args 限额、带标签 wire value、未知错误禁止安全重试的标记、集中 LIMITS 和静态类型检查。这些选择适合继续构建，但 F2/F3 破坏了恢复与终态语义，不能将这批 schema 当作已完成的 v1 协议冻结。

鉴权、执行器、SQL 确认和路径访问没有运行实现，本轮无法验证实际越权执行、数据库写入绕过、路径逃逸或重放攻击；“不存在服务”不等于这些防护已经做好。明确验证的安全相关问题是恢复身份缺失、终态语义错误，以及深层输入触发非结构化异常。

没有把以下情况误报为漏洞：通用 Lua/TS 按设计拥有调试能力且不额外执行 SQL 确认；截图明确不在本期；网站、旧 Prompts/Resources、模板生成、Prodigy、文件修改工具均被明确排除。框架方法仅验证通用 shape、尚无清单是功能缺失，不能在没有反射执行器的情况下声称已存在任意方法执行漏洞。

## 测试意图核查

| 意图 | 现有测试 | 判断与需要补充的层级 |
|---|---|---|
| 输入格式、日期、整数、字节预算 | config/ids/tools 等单测 | 基本纯函数层级正确；补超深结构与组合约束 |
| unknown 不能作为结束证据 | messages/errors 单测 | errors 标记测试有效，但 messages 错误接受 unknown-as-failed；必须修正 fixture 并补调度集成 |
| 跨重启身份恢复 | recovery 单测 | 仅测试 shape、禁敏感字段和历史条数；没有原目标匹配与持久化崩溃边界 |
| 资源读取独立于 FIFO | messages 单测 | 只测禁止进入 FIFO，还测试禁止 control；缺少合法读取的正向端到端路径 |
| wire 编码正确 | wire-value 单测 | 只是手写 wire 对象校验；不证明 Lua 尾 nil、JS holes、跨语言 vector/BigInt 编解码正确 |
| 工具发现 | registry 单测 | 检查枚举和 status 常量，不是 MCP tools/list；不能支撑“已注册十工具” |
| SQL 确认完整且不可复用 | approval shape 单测 | 不能验证 SQL 分类、参数修改、会话替换、资源重启和真实客户端 UI |
| 共享队列与连接生命周期 | 无 | 需要多入口进程级集成、假桥接和故障注入 |
| FiveM 与三个 AI 客户端互操作 | 无 | 需要 FxDK/直接 FXServer、ESX/QBCore/ox 和 Codex/Claude/CodeBuddy 实机矩阵 |

纯 schema 本身不需要启动 FiveM 做每个边界单测；完整交付必须有进程集成与真实宿主验收，不能用 67 个 shape 测试代替。`TaskSubmitSchema.arguments` 和 `ControlRequestSchema.arguments` 目前只是 z.json，注释假定已经校验；未来 broker 必须在可信边界调用对应工具 schema 并校验目标一致性。当前 `tool:execute_lua, arguments:{}` 在消息层通过、在公共输入层失败，是该未接线边界的直接证据，不单独计为已经发生的鉴权绕过。

## 本轮验证记录

| 检查 | 结果 |
|---|---|
| Node 版本 | v22.22.1 |
| npm --prefix mcp test | PASS：类型检查及 67/67 测试 |
| npm --prefix mcp run build | PASS：生成约 735 KiB ESM bundle |
| npm --prefix mcp audit --json | PASS：本次 registry 审计报告 0 个已知依赖漏洞；不代表源码安全证明 |
| 内建静态分析脚本 | PASS（以 Python -X utf8 重跑）；首次因 Windows GBK 无法输出 emoji 失败 |
| 构建产物 stdio initialize 探测 | FAIL（以完整 MCP 要求判断）：退出码 0、stdout/stderr 为空 |
| F2–F6 最小校验样例 | 已复现，输出见下 |
| 真实 FiveM、数据库、客户端 elicitation | NOT_EXECUTED；本轮没有启动或修改这些环境 |
| PR/MR CI 与 review threads | 不适用：本地目录全量 review；没有声称远端 CI 通过 |
| 审查期间源码变化 | 无；只运行检查/重建被忽略的 dist，并新增本报告 |

静态脚本将 `ISO_UTC_PATTERN.exec(value)` 标为危险执行，实际只是 RegExp 匹配，属于误报；其长函数检测把 if/for 片段识别为函数，未据此生成风格 finding。评分仅用于内部判断，没有用量化分数替代契约分析。

### 最小复现摘录

在仓库根目录用 Node v22.22.1 执行以下 ESM 脚本（通过 `node --input-type=module` 输入）：

```javascript
import * as m from './mcp/src/index.ts';
const id = '123e4567-e89b-42d3-a456-426614174000';
const error = {
  code: 'TIMEOUT_UNKNOWN', message: 'not known to have ended',
  sideEffectsUnknown: true, retrySafe: false,
};
console.log(m.TaskResultSchema.safeParse({
  taskId: id, target: {side: 'server'}, state: 'failed',
  error, queuedMs: 0, executionMs: 30000,
}).success); // true：未知被接受为终态
console.log(m.TaskStatusResultSchema.safeParse({
  taskId: id, state: 'succeeded', resultAvailable: true, error,
}).success); // true：成功状态携带未知错误
for (const action of ['list', 'status']) {
  const args = action === 'list' ? {action} : {action, name: 'demo'};
  console.log(
    m.ResourceInputSchema.safeParse(args).success,
    m.ControlRequestSchema.safeParse({requestId:id, tool:'resource', arguments:args}).success,
    m.TaskSubmitSchema.safeParse({requestId:id, tool:'resource', arguments:args}).success,
  ); // true false false
}
console.log(m.WireValueSchema.safeParse({
  kind:'bytes', base64:'AQID', byteLength:1000,
}).success); // true：实际为 3 字节
const nested = JSON.parse('['.repeat(2000) + '0' + ']'.repeat(2000));
try {
  m.ExecuteLuaInputSchema.safeParse({side:'server', code:'return args', args:nested});
} catch (e) {
  console.log(e.name, e.message); // RangeError Maximum call stack size exceeded
}
```

其它实测输出：`unbound-server-intent=true`、`server-identity-fields=false`、`completed-flag-rejected=false`（即携带完成字段的样例 success=false）；54,015 字节 wire array 解析抛 RangeError。复现没有发送实际游戏或数据库操作。

## 建议处理顺序与结论

先修 F2/F3 的身份和终态契约，补 F4 的合法读取路由与 F5 的解析限额，同时修 F6；然后再接 RFC 第一步的 stdio、broker、恢复存储和假桥接进程测试。连接与桥接早期就验证日志 marker、跨 Lua/JS 异步和 elicitation 可行性，随后实施 FIFO、适配、日志、资料与发布。

实现质量：纯 schema 基础有价值，但核心安全语义未闭合。完成度：只完成类型契约和测试基础，完整设计未完成。缺失与漏洞：存在明确功能缺口和 5 项契约缺陷，尚无证据支持完整运行服务安全或已完成验收的结论。
