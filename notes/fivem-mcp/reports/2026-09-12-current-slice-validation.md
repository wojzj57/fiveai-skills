# FiveM MCP 当前切片验证报告（2026-09-12）

本报告记录 2026-09-12 修复切片（F1–F4，实施计划 Task 1–4）完成后的整体回归、一体化交付物核验与用户数据保留结果，并按会话决定将真实 FiveM 宿主验证（实施计划 Task 6）登记为 NOT_EXECUTED。本报告只记录当前状态，不改写旧报告的历史结论。

- 实施计划：`notes/fivem-mcp/todos/2026-09-12-current-slice-remediation-and-host-validation.md`
- 对照 RFC：`notes/fivem-mcp/rfcs/nodejs-debug-mcp-rfc.md`、`notes/fivem-mcp/rfcs/unified-artifact-rfc.md`
- 修改前基线（计划记录，HEAD 临时归档副本中测得，不作为本轮验收数量）：根测试 16/16、MCP 149/149。

## 1. 源码/产物身份

| 项 | 值 |
| --- | --- |
| 基线 HEAD | `master` @ `8abd56b30848a9d04b15590729b2b2bb2872eafe` |
| 修复提交状态 | 未提交（保留可审查工作区 diff；本轮无 `git add`/commit） |
| 构建身份（覆盖当前工作区源内容） | `fiveai-mcp/0.1.0/bbd65c3312ba8294e25b98d1d2b0b0cced9cd1fc3cf6f0fe254ecee77d04b9e0` |

构建身份由 `scripts/build-identity.mjs` 从当前工作区源码计算（非 HEAD），本轮已核对四处一致：`getBuildIdentity` 实时计算 = 生成模块 `packages/mcp/src/generated/build-identity.ts` = ZIP 内 `dist/server.js`/`mcp/broker.mjs`/`mcp/entry.mjs` 内嵌常量 = 独立运行时 `status.buildId`（见 §4）。

命名文件工作区 diff（相对 HEAD，即 F1–F4 修复的全部触及路径）：

- 修改：`.gitignore`、`package.json`、`packages/fivem-plugin/README.md`、`packages/fivem-plugin/scripts/build-resource.mjs`、`packages/fivem-plugin/server/main.js`、`packages/mcp/package.json`、`packages/mcp/src/broker/server.ts`、`packages/mcp/src/build.ts`、`packages/mcp/src/shared/config.ts`、`packages/mcp/tests/process/broker-process.test.ts`、`packages/mcp/tests/process/fixtures/fake-bridge.ts`、`packages/mcp/tests/resource.test.ts`、`packages/mcp/tests/shared-config.test.ts`、`tests/unified-pack.test.mjs`
- 新增：`scripts/build-identity.mjs`、`tests/build-identity.test.mjs`、`tests/helpers/`（`unified-fixture.mjs`、`unified-fixture.d.mts`）、`tests/unified-fixture-preservation.test.mjs`
- 生成（gitignored，不进 ZIP）：`packages/mcp/src/generated/build-identity.ts`
- 与修复无关的既有工作区状态，原样保留：4 个旧 todo 删除、未跟踪 `skills-lock.json`、未跟踪计划文件。

## 2. 执行环境检查（Step 1）

| 检查 | 源码/产物身份 | 命令或操作 | 实际结果 | 证据路径 |
| --- | --- | --- | --- | --- |
| 工作区状态 | HEAD 8abd56b + §1 命名文件 diff | `git status --short` | 与计划预期一致：4 项既有删除 + 用户未跟踪文件 + §1 所列修改/新增；前后两次执行完全一致 | 本报告 §1、§5 |
| 环境版本 | — | `git rev-parse HEAD`；`node --version`；`pnpm --version` | 8abd56b30848a9d04b15590729b2b2bb2872eafe；v22.22.1；11.9.0 | 本报告 |
| 既有 broker | — | 枚举 fiveai 命名管道 | 无 fiveai 管道 → 无运行中 broker；观察到约 60 个 node.exe 进程（启动时间 2026-09-11 15:29 至 2026-09-12 22:34，多为其他会话工具进程），全部未触碰、未终止 | 本报告 |
| 用户工作区快照（执行前） | dist/fiveai-mcp（真实安装目录） | 文件列举 + SHA256 | 恰好 9 个白名单文件；`mcp/config.json` 220 字节，SHA256 `C5DC8B526E23BD2156C743B2A17839778FC16D83890D1D5818C3A8562CF15CCB`，mtime 2026-09-11 22:47；无 `mcp/state/`；无 `mcp/credentials.json`；旧 `dist/fiveai-mcp.zip`（2026-09-11 23:13，819,700 字节）待重建 | `dist/fiveai-mcp/mcp/config.json`；本报告 §5 |

## 3. 自动化整体回归（Step 2，串行执行，逐条核对退出码后继续）

| 检查 | 源码/产物身份 | 命令或操作 | 实际结果 | 证据路径 |
| --- | --- | --- | --- | --- |
| 全量测试 | §1 工作区身份 bbd65c33 | `pnpm run test:all`（根目录） | 退出码 0。根套件：20 测试 / 20 通过 / 0 失败 / 0 跳过 / 0 取消（基线 16 + preservation 1 + build-identity 3）。MCP 套件（前置 build:resource 一体化构建+发布、typecheck 0 错误、三项构建）：156 测试 / 156 通过 / 0 失败 / 0 跳过 / 0 取消（基线 149 + F2 快照 4 + F3 A/B 1 + F4 2） | 本节内联计数；测试源见 `tests/`、`packages/mcp/tests/` |
| Skills 校验 | 同上 | `pnpm run validate` | 退出码 0：`FiveAI plugin validation passed (9 skills).` | `scripts/validate-plugin.mjs`；`skills/` |
| Lua 5.4 harness | `packages/mcp/tests/fixtures/lua-executor-check.py` + `packages/fivem-plugin/shared/executor.lua` | `py -3 -X utf8 packages/mcp/tests/fixtures/lua-executor-check.py` | 退出码 0：`PASS: Lua 5.4 executor, 10 cases; FiveM coroutine/native/vector acceptance NOT_EXECUTED`（Lupa 存在并真实执行；FiveM 原生 coroutine/native/vector 部分由 harness 自身声明 NOT_EXECUTED，非本轮验证范围） | 本节内联输出；`packages/mcp/tests/fixtures/lua-executor-check.py`；`packages/fivem-plugin/shared/executor.lua` |
| 空白检查 | 同上 | `git diff --check` | 退出码 0：无空白错误；仅既有 autocrlf LF→CRLF 提示（13 个修改文件，非本轮引入） | 本报告 |

说明：根套件的 build/pack 全部在临时 fixture 工作区执行（F1 修复后不再触碰真实 `dist/` 的可保护文件）；`test:mcp` 前置的 `build:resource` 仍按设计把程序文件发布到真实 `dist/fiveai-mcp/`——发布路径保留本地 `mcp/config.json`，本轮 §5 已做前后字节对比验证。

## 4. 一体化交付物核验（Step 3）

| 检查 | 源码/产物身份 | 命令或操作 | 实际结果 | 证据路径 |
| --- | --- | --- | --- | --- |
| 构建 ZIP | 当前源码 | `pnpm run pack` | 退出码 0：`Unified artifact packed: D:\Exre\ex-fiveai\dist\fiveai-mcp.zip`（820,002 字节，2026-09-12 23:05 重建） | `dist/fiveai-mcp.zip` |
| ZIP 白名单 | 同上 | 解包列举条目 | 恰好 9 个白名单文件、单一 `fiveai-mcp/` 根、无第 10 个文件（生成身份模块是编译输入，不进 ZIP） | 本节 |
| ZIP 配置 | 同上 | 字节比较 | ZIP 内 `mcp/config.json` 与仓库默认配置 `packages/fivem-plugin/mcp/config.json` 字节一致（携带默认配置，绝不携带本地用户数据；无 credentials/state/用户文件条目） | 本节 |
| 独立运行 | 解包到带空格临时目录（无 node_modules） | `node <解包>\mcp\entry.mjs`（stdio） | initialize 成功（serverInfo `fiveai-mcp`/`0.1.0`）；tools/list 恰好 `["status"]`；tools/call status 成功：`buildId = fiveai-mcp/0.1.0/bbd65c33…`（与 §1 四处一致）、`bridge: null`（无 FiveM 宿主，符合预期）、`clients: []`、queue idle、recovery ok、registeredTools `["status"]` | 本节；`dist/fiveai-mcp.zip`（解包自该 ZIP） |
| 客户端 bundle | ZIP 内 `dist/client.js` | 文本扫描 | 无 `node:` 模块符、无 `require(`、无 import 语句（静态/动态）、无 `entryToken`/`bridgeToken`/`credentials` 凭据材料 | 本节 |
| 双端构建身份 | ZIP 内 server.js / broker.mjs / entry.mjs | 文本包含检查 | 三个 bundle 均内嵌当前 `BUILD_ID` 字面量（bbd65c33…） | 本节 |
| 首次运行边界 | 解包目录 | 运行后检查 | credentials.json 与 state/runtime.json 只在解包目录内生成；进程经 runtime.json pid 停止；无 `.credentials-*` 临时文件残留；无 fiveai 管道残留 | 本节 |

## 5. 用户数据保留前后对比（Step 3）

| 检查 | 执行前 | 执行后 | 结论 |
| --- | --- | --- | --- |
| `dist/fiveai-mcp/mcp/config.json` | SHA256 `C5DC8B52…F15CCB`，mtime 2026-09-11 22:47 | SHA256 `C5DC8B52…F15CCB`，mtime 2026-09-11 22:47 | 字节一致，发布路径未触碰（test:all 重发布 + pack 重发布两次验证） |
| `dist/fiveai-mcp/mcp/state/` | 不存在 | 不存在 | 无变化（无可对比项） |
| `dist/fiveai-mcp/mcp/credentials.json` | 不存在 | 不存在 | 无变化；凭据比较结论：未变化（本报告不记录凭据内容或哈希） |
| `git status --short` | §2 所列 | 与 §2 完全一致（对比在撰写本报告前完成） | 无预期外变更（dist/ 为 gitignored 构建输出；ZIP 为重建的交付物）。Step 4 撰写本报告后，唯一新增项为本报告文件自身的未跟踪条目 |

未发生任何用户数据变更。

## 6. F1–F4 修复验证结论

全部四项缺陷在本轮整体回归中由真实测试覆盖并通过（以下测试编号为 2026-09-12 `pnpm run test:all` 实际输出中的用例名）：

| 缺陷 | 结论 | 本轮实际证据 |
| --- | --- | --- |
| F1 / P1：根测试覆盖并删除真实 `dist/fiveai-mcp` 的用户文件 | **PASS** | 根套件 ok 15 `the unified pack test leaves the enclosing workspace's installed files untouched`（外层哨兵逐字节保留）+ ok 16–19（fixture 内 build/pack、发布保留、故障注入、独立解包）；真实 dist 仅由 `build:resource` 发布路径更新程序文件且 config 保留（§5 字节对比） |
| F2 / P2：broker 丢弃 `clients.snapshot`，status 恒为 `clients: []` | **PASS** | MCP 套件 ok 79–82：快照进入 status 且 `clientId` 过滤仅影响展示；同桥替换/清空自身绑定；epoch/重复 serverId/身份违规以 4007 关闭；断连清空且第二桥不能覆盖第一桥 |
| F3 / P2：产物缺 package.json 后版本回退 0.1.0；资源硬编码相同 buildId | **PASS** | 根套件 ok 1–3（同一源码不同目录/无 Git 身份相同、资源源码变化改变身份而运行时文件不影响、生成器字面量与导入纯度）；MCP 套件 ok 93 `mixed A/B unified artifacts: the broker rejects the foreign build with BUILD_MISMATCH (F3)`（真实 A/B ZIP 实物混用，4003 拒绝）；本轮 §4 四处身份一致 |
| F4 / Minor：Node Base64 宽松解码使非法编码通过凭据校验 | **PASS** | MCP 套件 ok 129 `credential tokens require canonical standard Base64` + ok 130 `bridgeToken rejects noncanonical encodings and longer standard tokens pass` |

## 7. 里程碑完成度（T01–T07）

| 里程碑 | 当前状态 | 依据 |
| --- | --- | --- |
| T01 基础通信 | 自动化层面完成：入口 stdio（initialize / tools list 恰好 `status` / status）、单 broker 启动互斥与生命周期管道、心跳与 30s 宽限、recovery 原子存储、假桥接进程链路 | 本轮 MCP 156/156（ok 78 假桥接握手进 status、ok 92 停止窗口等待等）+ §4 独立运行 |
| T02 双端执行资源 — 资源实现 | 已实现并经 VM 宿主/真实 WS 进程对端/Lua harness 验证：独立可执行双端 bundle（ok 112）、动态资源名下从 mcp/config.json 与凭据文件接入（ok 114–116、118）、JS 执行器保留 undefined/BigInt（ok 113）、Lua 5.4 执行器 10 项 | 本轮套件 + §3 harness；`packages/mcp/tests/resource.test.ts` |
| T02 双端执行资源 — 宿主验收 | **NOT_EXECUTED**（见 §8；TS 编译/AST 约束/ES2020 转换/source map 亦未实现，需独立执行器计划） | §8 矩阵 |
| T03 FIFO/恢复调度 | 未实现（无调度器消费恢复存储；status 自报 `queue.note: "scheduler not implemented in this build"`） | §4 status 实测输出 |
| T04 资源控制/日志 | 未实现 | — |
| T05 框架适配（ESX/QBCore/ox） | 未实现 | — |
| T06 SQL 确认（oxmysql） | 未实现 | — |
| T07 资料/Skills/发布 | 仅打包子项完成（§4 一体化 ZIP）；本地资料、三 AI 客户端验收、完整发布未完成 | §4 |

## 8. 真实宿主验证（Task 6）：NOT_EXECUTED

会话决定：本轮不执行真实 FiveM 宿主验证。未启动任何 FiveM/FxDK/FXServer 进程，未编辑任何 server.cfg，未在真实宿主做任何部署改动。以下矩阵为未执行占位，不得从自动化测试或旧报告推断为已通过。

| 环境 | 两种启动顺序 | Server 五项探针 | Client 五项探针 | 多客户端/重连 | 日志唯一映射 | 改名/下载边界 | FxDK watcher |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FxDK | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED |
| 直接 FXServer | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | NOT_EXECUTED | 不适用 |

未执行原因：本轮会话未获得真实宿主操作授权（用户决定推迟）；宿主门槛证据缺失，T03 前置决策保持开放。

### 8.1 验收清单（执行 Task 6 时逐项填写，均为 NOT_EXECUTED）

1. **两种启动顺序**（FxDK 与直接 FXServer 分别执行）：资源先、AI 后 —— 观察等待凭据与 notice 节流；AI 先、资源后 —— 观察自动连接。检查凭据只生成一次、status bridge 非空、buildId 一致、客户端连接后可列出与筛选。两次运行之间按正常生命周期停用，不删 state 改变结果。
2. **Server/Client 固定探针（各五项）**：将测试 config `verifyEnabled` 设为 true（配置摘要变化，须先停相关 entry、等待旧 broker 退出再重启），在 server console 依次运行 `fiveai_mcp_verify server` 与 `fiveai_mcp_verify <当前真实 clientId>`，记录五项 `FIVEAI_MCP_VERIFY` 结果：
   - `lua-await-multiple-nil`：Citizen.Wait(50) 后按顺序返回 `"fiveai"`、nil、7、尾 nil，保留四个返回位置；
   - `lua-vector`：保留 vector3 类型及数值 1、2、3；
   - `lua-error`：failed / EXECUTION_ERROR，消息包含 `fiveai expected error`，执行完成证据为 true；
   - `javascript-await`：等待后返回数组 `"fiveai"`、undefined、BigInt 42、当前实际资源名（不得丢失 undefined/BigInt）；
   - `javascript-error`：failed / EXECUTION_ERROR，消息包含 `fiveai expected error`，执行完成证据为 true。
   结果未知时停止该序列、保留原调用及日志，不自动重试。
3. **多客户端/重连/epoch**：两客户端同时在线，记录各自 serverId/clientEpoch/logMarker，status 筛选分别匹配；重连或 ID 复用时核对 epoch 更新且旧绑定消失。
4. **日志唯一映射**：在实际 CitizenFX 日志中检索精确 `FIVEAI_MCP_SESSION` marker，记录对应文件与当前 epoch（文件时间最新不能作为归属依据）；共享文件不能唯一归属时记 FAIL，并停止推进依赖日志归属的设计。
5. **安装边界**：资源改名后重复连接和一次探针；检查客户端实际下载内容不含 `mcp/config.json`、`credentials.json`、broker 或 entry；观察 FxDK 凭据/state 写入是否触发自动重启（按实际观察记录），并验证关闭该资源自动重启后的手动重启流程；错误配置/坏凭据不降级连接（用独立测试安装副本验证，不得破坏已初始化的唯一有效凭据）。
6. **FxDK watcher**：观察 FxDK 对凭据/state 写入的自动重启行为并记录（仅 FxDK 行；直接 FXServer 不适用）。
7. **收尾**：每宿主记录宿主版本、源码 commit/未提交 diff、buildId、ZIP 标识、客户端版本、输入、实际输出、脱敏日志路径及 PASS/FAIL/NOT_EXECUTED；`verifyEnabled` 恢复 false 并按摘要变更流程重启已授权进程；只清理本轮明确拥有的临时文件。

### 8.2 执行前需要的环境信息（请求提供）

- 测试项目绝对路径与资源安装目录（ZIP 解包目标位置）；
- 允许修改的配置范围（如 `verifyEnabled`、broker 端口、server.cfg 中 `ensure fiveai-mcp`）；
- 允许启动/重启的宿主与客户端（FxDK / 直接 FXServer；server console 的访问方式）；
- 既有 entry/broker 进程是否需要停止、可否清理测试 state/凭据（仅限测试安装副本）。

## 9. 结论

- F1–F4 全部 **PASS**（§6），整体回归全绿：根 20/20、MCP 156/156（0 失败/跳过/取消）、validate 9 skills、Lua harness 10 项、`git diff --check` 干净（§3）。
- 一体化交付物从当前源码重建并独立解包验证：9 文件白名单、默认配置、双端构建身份一致、客户端 bundle 无凭据/Node API、stdio initialize/tools/status 可用（§4）。
- 用户数据零变更：config 字节一致、state/凭据前后均不存在、git 状态前后一致（§5）。
- 真实宿主验收保持 NOT_EXECUTED（§8）；T03 及后续门槛决策待宿主证据成立。
