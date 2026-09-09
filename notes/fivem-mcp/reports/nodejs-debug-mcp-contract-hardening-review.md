# Node.js FiveM 调试 MCP — 契约加固代码审查

审查日期：2026-09-09。模式：working-tree，覆盖本轮全部 17 个触及路径（15 修改 + 2 新增，均在 `mcp/`）；输入为上一轮报告 `nodejs-debug-mcp-review.md` 的 F2–F6 契约缺陷、RFC §5/§6/§7/§8/§11 与已确认设计。代码基线：`77ad47ad7ede8ef60f8b7ee3178c50abab0e680b`（`master`），审查对象为工作区未提交变更；`notes/` 本身为未跟踪基线。

## Findings

共 2 项：P0 0、P1 0、P2 1（已在本轮修复并复验）、P3 1（非阻塞说明）。无遗留阻塞问题。

### R1 · [P2]（已修复）迭代边界检查接受了 z.json() 会拒绝的异构对象

位置：[mcp/src/protocol/json-bounds.ts](../../../mcp/src/protocol/json-bounds.ts) `checkJsonBounds` 的对象分支。

问题：`Date`/`Map`/`Set`/类实例进入 `typeof "object"` 分支后按自有可枚举属性遍历，等价于被当作（近似空的）普通对象放行；实测四者全部通过，而被 `boundedJson` 替换的 `z.json()` 拒绝它们。替换后校验与 `JSON.stringify` 序列化行为出现分歧：`Date` 经 toJSON 变成字符串、`Map`/`Set` 变成 `{}`，即"校验通过但编码形态与校验所见不同"。JSON 传输路径不可达（`JSON.parse` 不产生异构对象），风险限于程序化误用路径的契约削弱，故定 P2 而非 P1。

修复：对象分支增加原型检查，仅接受 `Object.prototype` 或 `null` 原型（`Object.create(null)` 与数组不受影响）；新增测试覆盖四种异构对象的拒绝与 `Object.create(null)` 的接受。修复后全部验证重跑通过（88/88）。

### R2 · [P3] protocol → tools 的单向依赖形成维护边界，需保持方向约束

位置：[mcp/src/protocol/messages.ts:12](../../../mcp/src/protocol/messages.ts)。

`messages.ts` 为控制通道与 `bridge.read.request` 的资源读取校验，从 `tools/schemas.ts` 导入 `ResourceInputSchema`/`ResourceNameSchema`。依赖无环、单一目的、符合 RFC §3.1"工具 schema 和内部消息从同一声明产生"；但若未来 `tools/schemas.ts` 反向引用 messages.ts 即成环。建议运行时接线阶段保持该方向约束，或将资源读取参数子集下沉到 protocol 层。非缺陷，仅作边界记录。

## 变更与 findings 对照

| 上轮 finding | 本轮处置 | 证据 |
|---|---|---|
| F1 交付缺口（非可连接服务） | 不在本单元范围（用户确认仅做 F2–F6）；包描述与 index.ts 注释已如实标注 contracts-only | 范围决策记录于会话 |
| F2 恢复记录缺原目标身份 | hello(bridge) 必填 `environment{bridgeEpoch,serverPid,serverStartedAt,serverIdentityVerifiable}`；task.result 两分支必填 `executedBy`；DispatchIntentRecord 必填 `environment`；新增纯函数 `matchesDispatchIntent`（taskId+target+environment 全等才匹配） | messages.ts / recovery.ts / recovery.test.ts 匹配矩阵 |
| F3 终态接受未知执行 | failed 终态拒绝 TIMEOUT_UNKNOWN/CONNECTION_LOST_UNKNOWN；新增必填 `evidence{executionCompleted,noRemoteExecution}` 并按错误码约束（COMPILATION_ERROR→false/true；RESULT_UNSERIALIZABLE/TOO_LARGE→executionCompleted=true）；TaskStatusResult 按状态判别 result/error/evidence/resultAvailable 组合，unknown 仅允许观测错误码 | messages.test.ts 状态矩阵 |
| F4 资源读取无路由 | `resource` 以 action 级限制加入 CONTROL_TOOLS；ControlRequestSchema 与新的 BridgeReadRequestSchema 仅接受 list/status；新增 `bridge.read.request/result` 消息与 `ResourceReadResultSchema`（source live/cached）；消息总数 18→20 | messages.test.ts 全链路断言：public ✓ / control ✓ / bridge.read ✓ / task.submit ✗ / dispatch ✗ |
| F5 深层输入 RangeError | 新增迭代式 `checkJsonBounds`/`checkWireBounds`（显式栈，深度 32、元素 10,000；输入策略对齐 RFC 结果上限）；`boundedJson`/`boundedJsonArray`（z.custom）替换全部递归 `z.json()` 字段；`BoundedWireValueSchema`/`BoundedExecutionValueSchema`（z.preprocess）用于接收端；control.result 仅深度限制（日志响应可超万节点，字节上限另管） | json-bounds.test.ts 边界与 10 万层不抛错；wire-value.test.ts 32/33 层与元素边界；messages/tools 深层结构化失败 |
| F6 bytes 长度矛盾 | 按 base64 长度+padding 计算实际字节数与 `byteLength` 比对 | wire-value.test.ts 过大/过小/空/padding 用例 |

## 测试意图核查

| 意图 | 覆盖 | 剩余缺口 |
|---|---|---|
| F2 身份匹配：PID 重用、桥接重启、服务器更换、clientEpoch 变化、可验证性差异 | `matchesDispatchIntent` 纯函数矩阵（6 组反例+正例） | broker 真重启、第二 Server 接入、迟到结果对账需要运行时切片的进程级测试 |
| F3 终态语义：未知不得为终态、状态矛盾拒绝、证据按阶段 | 状态矩阵 + 错误阶段矩阵 + 上轮全部复现样例翻转 | 调度器消费契约的集成验证随运行时切片 |
| F4 读取路由完整链路 | public→control→bridge.read 逐层断言 + FIFO 双重阻断 | "FIFO 暂停时读取仍可发起"需运行时 |
| F5 解析限额 | 深度/元素/类型边界、10 万层迭代安全、4 类消息+3 类工具+wire 接收端结构化失败 | 编码器侧限额执行随执行切片 |
| F6 bytes 一致性 | 过大/过小/空/padding | 无 |
| 工具发现与 JSON Schema | registry 漂移守护重跑通过（10 工具全部可生成） | args 字段现为 any+default 形态（见下） |

已知非阻塞限制：`toolInputJsonSchema` 中 args 类字段由递归 JSON Schema 变为 `{default:…}` 的 any 形态（zod 4.5.4 的 z.custom 生成能力所限，且动态 message 参数不受支持）；运行时仍以服务端校验为准，与既有"refinements 不可见"的文档化限制一致。

## 本轮验证记录

| 检查 | 结果 |
|---|---|
| Node 版本 | v22.22.1 |
| npm --prefix mcp test | PASS：typecheck + 88/88（上轮 67/67；新增 21 项） |
| npm --prefix mcp run build | PASS：748.3 KiB ESM bundle |
| 根 npm test | PASS：11/11 |
| npm run validate | PASS：9 skills |
| 内建静态分析（py -3 -X utf8） | 0 any / 0 @ts-ignore / 0 未处理 Promise / 0 硬编码；1 处 `RegExp.exec` 误报（与上轮相同）；"超长函数"多为 if/for 块误判 |
| 上轮复现脚本重放 | F2/F3/F4/F5/F6 全部按预期翻转（true false false 等） |
| 真实 FiveM、数据库、三客户端、远端 CI | NOT_EXECUTED；本轮未启动或修改这些环境 |

## 结论

F2–F6 五项契约缺陷全部闭合且有对应测试证据；审查中发现并修复 1 项 P2 契约削弱（异构对象放行）。v1 wire contract 现可视为收敛候选，后续运行时切片（stdio 入口、broker、恢复存储、假桥接进程测试，即 RFC §16.1 第一步剩余部分）可在此基线上开工。本报告不构成合并/通过结论；无远端 CI 可读取。
