# Node.js Debug MCP 当前进度与质量审查

## Findings

本轮发现 **5 项：P0 0、P1 0、P2 5、P3 0**。这些是当前运行切片的可复现契约缺陷；后续未开发功能另列，不混算成代码 bug。当前只有只读 status，没有执行器，因此不把未来可能发生的误执行描述为已经发生。

### F1 · [P2] 握手后没有校验信封身份，错误会话和 broker 代际仍可发请求

位置：[server.ts:318](D:/Exre/ex-fiveai/mcp/src/broker/server.ts:318)。入口接收路径也缺少对应检查：[entry.ts:241](D:/Exre/ex-fiveai/mcp/src/cli/entry.ts:241)。

`parseMessage` 只检查 UUID 格式及字段存在。broker 完成 hello 后直接按 type 分派，没有比较 message.brokerInstanceId 与当前实例、message.sessionId 与当前连接绑定值。真实 WS 探针完成合法握手后，将两个字段都替换成全新 UUID，仍收到成功的 control.result。

这违反 RFC §5.1 的绑定身份约束，无法拒绝旧代际或错误会话的协议流量。当前响应仍发往原 socket，**未证明能够读取另一会话私有数据或代替另一会话执行操作**。但这个入口不能直接作为后续任务、确认和恢复消息的可信接收边界。

最小修复：在业务分派前统一核验连接绑定身份及角色允许的消息集；入口对 welcome 后的返回消息做相同校验，拒绝重复 welcome。补真实 WS 用例：合法 UUID 但错误 session、旧 brokerInstanceId、错误角色消息；拒绝后不进入 handler。不能只补 UUID 格式测试。

### F2 · [P2] 合法 pending 恢复记录被 status 显示为未阻塞

位置：[server.ts:432](D:/Exre/ex-fiveai/mcp/src/broker/server.ts:432)，相关输出在 459–480 行。

dispatchBlockedReason 只考虑加载失败和写入错误，没有考虑 recovery.file.pending。探针预先写入通过 RecoveryFileSchema 的 dispatch_intent 后启动 broker，启动日志明确说任务未解决、应保持阻塞，但 status 返回：

```json
{
  "recovery": { "status": "ok", "pendingTaskId": "519d0dcc-0109-411d-9c04-cd20818bf883", "historyEntries": 0 },
  "dispatchBlocked": false,
  "dispatchBlockedReason": null,
  "queue": { "state": "idle", "queued": 0, "runningOrUnknown": 0, "note": "scheduler not implemented in this build" }
}
```

RFC §7.2 要求已落盘意图按“可能下发”恢复。当前缺陷是恢复状态误报，尚无调度器可证明实际越过阻塞。现有 corrupt 文件用例不能覆盖“格式合法但任务未解决”。

最小修复：区分存储可读与任务已解决；pending 非空必须反映阻塞及原 taskId，不报告空闲的执行状态。未来下发条件应共享这套状态判定。增加 pending、空记录、损坏、未知版本和写失败的进程级状态矩阵。

### F3 · [P2] 配置加载没有执行约定的真实路径与 junction 归属检查

位置：[config.ts:146](D:/Exre/ex-fiveai/mcp/src/cli/config.ts:146)，直接落盘位置：[server.ts:173](D:/Exre/ex-fiveai/mcp/src/broker/server.ts:173)。

config loader 只解析绝对路径字符串，随后直接返回配置并计算摘要。broker 对这些路径直接 mkdir、读恢复文件、写 runtime.json 和 owner.lock；没有 realpath、最近存在祖先或链接归属校验。protocol/config.ts 的注释声称这些检查在启动时完成，实际尚未接线。

在独立临时目录将配置 stateDir 建为指向另一目录的 Windows junction，loader 保留原始路径，broker 成功把 runtime.json 写到 junction 目标。探针输出 retainedUnresolvedPath=true、runtimeWrittenOutsideState=true；没有拒绝或记录经过验证的真实目录。

这是 RFC §4.1 明确要求的启动文件边界缺口。它不等于任意远程用户已能指定路径；当前配置仍由本机用户控制。

最小修复：在使用配置和生成摘要前规范化真实路径，对尚不存在目录验证最近存在祖先；明确允许的链接归属并验证固定内部文件，发现不符合约束时在写文件前失败。补 Windows junction、内部文件链接及路径别名用例。凭据 ACL 的安装检查也尚无交付流程，应在安装任务中闭合，不能把字符串校验视为权限验证。

### F4 · [P2] 鉴权发生在 WebSocket 升级后，未落实升级前拒绝契约

位置：[server.ts:150](D:/Exre/ex-fiveai/mcp/src/broker/server.ts:150)，拒绝逻辑在 onConnection 中。

Fastify WebSocket handler 被调用时连接已经升级，当前 token、Host、Origin 校验均发生在这里。真实客户端携带错误 token 时先触发 open，再以 4401 关闭，探针得到 upgraded=true。已有测试也只断言 close code，未验证 HTTP upgrade 被拒绝。

这与 RFC §5.1 的升级前校验不一致；未鉴权连接仍获得 WS 对象并进入关闭握手，增加本可避免的连接资源占用。当前没有收到 welcome 或获得业务权限，因此不称为鉴权绕过。

最小修复：在 Fastify 升级前的请求 hook 校验角色 token、Host、Origin 与远端回环地址，返回明确 HTTP 拒绝；WS hello 再承担协议/构建兼容协商。回归测试应断言无 open、无 101，而不仅是最终断开。

### F5 · [P2] status 把桥接自报的进程身份原样标记为可验证

位置：[server.ts:451](D:/Exre/ex-fiveai/mcp/src/broker/server.ts:451)，接收位置为 handleHello。

broker 原样保存并输出 hello.environment，未对本机 PID 和进程创建时间进行核验。使用有效 bridge token、自报 PID=2147483647、创建时间=2000-01-01T00:00:00.000Z、serverIdentityVerifiable=true 的探针仍完成握手，status 原样返回 true。

RFC §5.2 要求身份可在本机核验；无法核验时必须明确标记不可验证，不能用于环境恢复。当前尚未实现环境恢复，因此已证实的是状态可信度问题，而非实际错误恢复。假桥接测试把自己的当前时间当创建时间，并断言 true，未测试真实进程身份边界。

最小修复：区分桥接报告与 broker 核验结果；查询本机进程身份，无法证明时输出不可验证及原因。增加不存在 PID、创建时间不一致、PID 重用、权限不足和真实匹配用例。后续恢复仅使用 broker 核验结果。

## 范围与证据基线

- 日期：2026-09-09；工作区：D:\Exre\ex-fiveai。
- HEAD：d8d84c05d6c41896a3e7ef44a3ba929144db8313；结论针对 **HEAD 加当前未提交源码和未跟踪文件**，不只针对 commit。
- 已有改动包括 mcp/package*.json、protocol、测试，以及未跟踪的 cli、broker、build.ts、close-codes、进程测试和 recovery-store 测试。此前的 completeness-review.md 与 skills-lock.json 也已经存在。
- 检查仓库布局、根测试与发布配置，深读当前 Node MCP 契约、运行入口、broker、存储和测试；旧 fivem-mcp-main 是 RFC 明确保留的历史实现，本报告不构成对旧 PHP 系统逐行安全审计。
- 仓库根没有 .codegraph/，依照指示跳过 CodeGraph。
- 本轮只新增本报告和下一步任务文档；运行本地构建、测试及隔离临时目录中的探针，没有修改生产源码、启动 FiveM、提交或推送。测试和探针结束后 lifetime pipe 探测为 absent。
- 本报告没有用 RFC 历史“未实施”文字或旧报告结论代替当前源码证据。

## RFC 完成度

当前已经从纯契约包推进到 **可通过 stdio 调用 status 的 broker 原型**。RFC §16.1 第一步已有主要运行链路，但仍有上述基础缺陷及验收缺口，不能认定整个第一步已闭合。第二至第五步主要业务尚未实施。不用文件数或测试数量推算功能百分比。

| RFC 范围 | 当前状态 | 实际证据与剩余工作 |
|---|---|---|
| §3 包、依赖与构建 | 基础已实现 | ESM、精确依赖、lock、typecheck；产物 index/entry/broker；根有 test:mcp，发布 files 尚未包含 MCP |
| §4 stdio、单 broker、SID pipe | 主要路径已实现 | 真实 initialize、tools/list、tools/call；10 入口竞争、不同配置拒绝、端口冲突测试通过 |
| §4 心跳、退出、重连 | 部分实现 | broker 心跳、入口断开清理、30 秒退出已测；宽限期复用、停止期间新入口、持续失败重连仍缺专项验证 |
| §4 配置及启动文件边界 | 部分实现 | JSON/路径格式/token 长度/摘要已有；F3；没有完整凭据安装与 ACL 验收 |
| §5 WS 与身份绑定 | 部分实现 | 角色 token、buildId、单 bridge 已接通；F1/F4/F5；adapterDigest 尚未匹配兼容清单 |
| §5 Server/Client 桥接 | 未开发 | 没有 resources/fiveai-mcp；无 source、challenge、clientEpoch 绑定和宿主线程分派 |
| §6 十工具输入与 wire value | 契约层已具备 | strict schema、容量、错误、标签值校验；没有原运行时编码器/执行结果闭环 |
| §6 实际工具能力 | status 部分实现；其余未开发 | status 只有 broker/握手/恢复摘要，clients 固定空；queue、execute_lua、execute_ts、resource、logs、esx、qbcore、ox、reference 均未注册 |
| §7 恢复文件 | 部分实现 | 临时文件、fsync、rename、加载校验；F2；无任务下发 write-ahead/settled/ack 运行链 |
| §7 FIFO、缓存、取消、unknown、恢复 | 未开发 | 有类型、状态和身份匹配函数；没有 scheduler、20 秒返回、迟到终态处理和故障注入 |
| §8 Lua/TS 执行器 | 未开发 | 无 load/xpcall、TS AST 限制/转换、source map、await、双端编码与去重执行 |
| §9 框架及 ox 适配 | 未开发 | 无 data/adapters、执行端方法清单、版本探测、参数映射、玩家投影 |
| §10 SQL 分类与确认 | 未开发 | 有 approval 消息 schema；无 SQL parser、保守 SELECT 分类、elicitation、一次性审批及 generation 复核 |
| §11 资源控制 | 契约已有，运行未开发 | resource 输入与控制通道 schema；无 native 查询、原子 restart、自身保护和阶段观测 |
| §12 日志 | 未开发 | 有日志消息和输入 schema；broker 丢弃 logs.batch/clients.snapshot；无采集、tail、marker 映射和真实 fixtures |
| §13 reference | 未开发 | 无随包资料、来源清单、索引、稳定排序、受限网络回退 |
| §14 Skills | 未开发新增工作流 | 现有 9 个通用 Skill 仍通过验证；缺 fivem-mcp、fivem-nui-debug、ox-target 及生成方法参考 |
| §14 截图禁用 | 当前切片已落实 | false 常量，无捕获实现；真实 tools/list 只含 status，不含 screenshot |
| §16 发布与验收 | 未完成 | 无完整桥接包/解包验证；FiveM、FxDK、数据库和三 AI 客户端均未验收 |

排除项继续保持：网站、旧 Prompts/Resources、模板生成、文件操作工具、FXServer 启动工具、NUI/CDT 代理、截图捕获。现有 fivemanage Skill 的通用图像知识不等于本 MCP 注册了截图工具。

## 旧报告问题的本轮复核

旧报告：[nodejs-debug-mcp-completeness-review.md](../reports/nodejs-debug-mcp-completeness-review.md)。它记录的是先前工作区快照，不覆盖当前新增的运行代码。

| 旧编号 | 本轮判断 |
|---|---|
| F1：产物无法 initialize | entry.mjs 真实 stdio 测试已通过；旧 index.mjs 仍是契约产物，不能继续拿它当服务入口评判；完整业务缺口仍存在 |
| F2：failed 证据不完整 | failureEvidenceIssue 已由直接结果和状态查询复用，错误阶段矩阵测试通过；对应反例已修复 |
| F3：内部包装预算拒绝合法 args | MESSAGE_ARGUMENTS_JSON_BOUNDS 补充包装预算，public→submit→dispatch 边界测试通过 |
| F4：JSON Schema 丢失数组类型 | boundedJsonArray 显式数组形状已实现，生成 schema 的类型测试通过 |

## 测试意图与质量判断

| 本轮执行 | 结果 | 证明范围 |
|---|---|---|
| Node 版本 | v22.22.1 | 本轮环境，不代表所有受支持补丁版本 |
| mcp npm test | PASS：107/107，0 skipped | 包含 tsc、三个产物构建、契约与存储测试、10 个进程场景；约 71.6 秒测试耗时 |
| 根 npm test | PASS：11/11 | 插件校验行为 |
| 根 npm run validate | PASS：9 skills | 当前多宿主 metadata、Skill 结构和引用 |
| Skill analyze.py（UTF-8） | 完成 | 扫描 43 个 JS/TS 文件；0 显式 any、0 ts-ignore；不等于安全验证 |
| 真实 WS + 临时磁盘补充探针 | F1–F5 均复现 | 使用当前 Broker/loader 实现，不经过 FiveM；不是已提交的回归测试 |
| FiveM/FxDK、多客户端、框架、数据库 | NOT_EXECUTED | 缺实现，不能从假桥接测试推定宿主接受 |
| Codex/Claude/CodeBuddy | NOT_EXECUTED | 自建 stdio 客户端通过不代表三产品及 elicitation UI 通过 |
| 远端 CI / review threads | NOT_EXECUTED | 本地审查，未指定 PR/MR；不给合并批准 |

静态扫描把 RegExp.exec 当危险调用、把目录中的旧 PHP 与新 Node 模块识别为微服务，并把部分 if/for 块误判为长函数；这些不作为缺陷。当前职责已有 cli/broker/protocol 分离，严格输入、集中限制和真实产物测试是可继续使用的基础。

主要质量问题在测试断言的层级：身份测试验证“字段合法”但没有验证“连接绑定”；鉴权测试验证“最后断开”但没有验证“未升级”；存储测试覆盖损坏但未覆盖合法未决；假桥接自报身份被直接当成核验结果。这些都需要行为测试，而不是增加同实现结构一致的断言。

第一阶段还缺：停止期间连接及宽限期复用、损坏/不可写状态下启动清理、frame 上限、反复重连失败、配置真实路径，以及 crash 前后持久化边界。无 scheduler 时可以验证文件失败及状态展示，不能声称已经验证“不重复执行”。

## Summary

当前已有可运行的 broker/status 基础，先前三个契约反例已经修复，整体仍不是可用的 FiveM 调试 MCP。先修 F1–F5 并补第一阶段进程验收，再验证双端执行与日志映射的真实宿主可行性，之后开发 FIFO 和业务工具。执行顺序及完成条件见[下一步任务](2026-09-09-nodejs-debug-mcp-next-steps.md)。
