# HTTP MCP 开发与验证记录

日期：2026-09-22。实施基线：`292dbc31d5b2b132fb16248dac20bd0c9837bd5b`。

按两个 2026-09-22 RFC 实施。用户已同意在当前有修改的工作区继续，并以 HEAD 中基础 RFC/Schema 为基准，新 RFC 优先。保留原有修改和删除；没有提交、推送、部署或重启宿主。

## 已落地代码

- 单资源直接提供本机 Streamable HTTP MCP，严格配置、会话与协议边界；唯一工具注册表连接十个 handler 和 input/output Schema。
- TypeScript 5.9.3 普通 CJS 编译模块，从实际资源路径加载；同步准备、返回后 5000ms 预算、取消与派发前复核、源码位置映射。没有编译 Worker 或外部编译进程。
- 全局 FIFO、明确派发提交边界、可信终态、unknown 暂停与证据恢复、有界队列/终态/会话关闭记录。
- Server/Client Lua 与 JS 执行、WireValue、完整客户端 binding、心跳、去重、终态缓存/ack/probe；执行前预留客户端终态容量。
- 精确资源控制、最终状态观察、异常后的 unknown；服务端日志及按随机标记归属的客户端文件日志。轮询、尾部扫描和保留缓冲均有界。
- ESX/QBCore/ox 固定方法、玩家连接代际与投影；SQL 保守分类及原 POST SSE 上的 form elicitation；固定离线 reference 核心和受限在线回退。
- 自包含 server/client/Lua 产物、真实单根 ZIP、SHA-256 清单、依赖许可证、独占锁、配置保留、未知文件拒绝和 ZIP 发布失败回滚。
- 更新 README，增加显式运行的宿主编译基准脚本；不会自动调用或启动宿主。

## 离线证据

| 检查 | 状态 | 范围 |
| --- | --- | --- |
| `corepack pnpm --dir fivem-mcp test` | PASS | 类型检查及 84 个 Node 测试；所有构建使用临时 fixture |
| `py -3.11 fivem-mcp/tests/fixtures/http-lua-check.py` | PASS | 实际 Lua 5.4 执行器 13 个用例及框架替身的适配/投影检查 |
| HTTP 集成 | PASS | 初始化、十工具、输入/输出、TS 队列、Lua 本地终态、客户端协议替身、SQL 原流批准/拒绝、停止/重绑及端口冲突 |
| 异步执行 | PASS | await、for-await、async generator、嵌套 async、super、源码映射与 Host Tick 恢复 |
| 生命周期与边界 | PASS | 超预算不派发、取消竞争、unknown/迟到证据、队列/缓存容量、玩家与客户端代际、日志增长/扫描预算、会话关闭记录有界 |
| 打包与恢复 | PASS | ZIP/哈希、自包含加载、改名/空格路径、配置保留、未知文件拒绝；Windows 锁定旧 ZIP 的失败回滚由独立审查复现 |
| `git diff --check` | PASS | 无补丁空白错误 |
| 独立 working-tree 审查 | PASS | 任务中心、集成、客户端、交付四个范围均 ACK；无未解决 P1/P2 |

离线 HTTP、客户端和框架替身验证接线与状态机，不证明真实 FiveM、真实数据库或框架的行为。

完整评审证据保存在工作区 `.superpowers/sdd/http-mcp-delivery/`：`center-review.md`、`integration-review.md`、`client-review.md`、`delivery-review.md`。最终全量日志为同目录的 `test-output.txt`，结果 84/84 PASS。不同审查阶段的定向测试计数不同，以最终全量为当前汇总。

## 未执行的实机验收

以下均为 **NOT_EXECUTED**，因此不能宣称两个 RFC 的完整宿主/发布验收已经通过：

- 默认 FxDK artifact 和直接 FXServer 的加载、server Lua/TS、实际 native/exports、资源重启和端口释放。
- 两个真实客户端的 Lua/TS、断线重连、ID 复用、可信终态及实际 CitizenFX 日志目录权限/归属。
- 对应固定版本 ESX/QBCore/ox 的全部真实方法，以及专用数据库中的批准、拒绝与真实写入效果。
- Codex、Claude Code、CodeBuddy 分别初始化与 form elicitation。
- 真实宿主冷启动及四类输入各 20 次准备耗时、并发 status 延迟。辅助命令：`node fivem-mcp/scripts/benchmark-http-mcp.mjs --help`；实际准备耗时来自 `FIVEAI_MCP compiler` 日志，不能以 HTTP 调用耗时替代。

本轮代码与离线修复工作不自动授权部署或宿主重启。编译仍会同步占用 Node 事件循环；预算不能中断 CPU 工作，资源重启也不能撤销已经发生的游戏/数据库副作用。
