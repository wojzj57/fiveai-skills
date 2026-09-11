# Node.js Debug MCP 实施记录

本轮从 `master` / `d8d84c05d6c41896a3e7ef44a3ba929144db8313` 加既有未提交实现继续。用户已明确允许修改重叠文件；未要求 commit、push 或部署。原 RFC 与审查报告保留为历史证据。

## T01 实现与验证

- F1：broker 按连接身份和角色检查消息；entry 核验 welcome 的信封/载荷一致性、后续身份及消息方向，重复握手关闭连接。反例先通过完整 schema 校验，再验证不进入业务处理。
- F2：合法 `dispatch_intent` 保留原 taskId 并报告阻塞、一个 running/unknown；文件健康与任务解决状态分离。
- F3：显式配置根允许 junction 别名，但先解析真实路径及最近存在祖先；摘要使用解析后的配置。固定状态文件拒绝链接、硬链接及非普通文件，启动和存储时复查。临时恢复文件采用唯一名称、排他创建及完整写入。
- F4：角色 token、Host、Origin 和回环来源在 HTTP 请求 hook 中验证；错误凭据返回 HTTP 401，测试断言未触发 WebSocket open。
- F5：本机查询 PID 创建时间，将核验结果与桥接自报内容分开；不存在、时间不一致或无法访问时不可验证。适配 digest 如实标记清单未实现，不声明兼容。
- 生命周期：入口重连使用单一可取消计时器，连接成功后不建立重复连接；启动失败关闭服务并释放句柄；退出先停止 HTTP/WS，再释放 lifetime pipe，包含未握手连接清理。

本轮源码/测试路径：

```text
mcp/src/cli/config.ts
mcp/src/cli/paths.ts
mcp/src/cli/entry.ts
mcp/src/broker/server.ts
mcp/src/broker/process-identity.ts
mcp/src/broker/recovery-store.ts
mcp/tests/runtime-config.test.ts
mcp/tests/process-identity.test.ts
mcp/tests/process/broker-process.test.ts
```

`npm test` 重建被 Git 忽略的 `mcp/dist/index.mjs`、`entry.mjs`、`broker.mjs`。既有 package/protocol 改动、其他未跟踪文件及历史审查材料未被替换或提交。

| 验证 | 实际结果 |
|---|---|
| Node | v22.22.1 / Windows |
| 修复前 MCP 基线 `npm --prefix mcp test` | PASS，107/107 |
| 新增鉴权、身份自报、路径别名及 pending 反例 | 修复前 FAIL，修复后 PASS |
| 修复后 MCP 完整 `npm --prefix mcp test` | PASS，115/115，0 skipped；包含 typecheck、最新三产物构建；66.4 秒 |
| 根 `npm test` | PASS，11/11 |
| 根 `npm run validate` | PASS，9 Skills |
| `git diff --check` | PASS；仅既有 LF/CRLF 提示 |
| 独立 code-review 完整路径检查 | PASS；初审、补测及最新产物复核后无阻塞问题；覆盖全部本轮源码、测试、实施记录及产物来源 |
| 测试结束 lifetime pipe 探测 | `absent`，无本轮 broker 遗留 |

未观察到基线测试失败。npm 提示用户配置 `email` 将被后续版本移除，不属于本次源码缺陷。

审查补测已通过：存储 writer 故障注入后，真实 broker/WS 状态仍可读且阻塞；通过未结束的真实 HTTP 请求保持停止窗口，新入口等待原 lifetime 结束后才创建后继实例。进程身份用本机 OS 创建时间验证，并以同 PID/不同创建时间模拟重用边界；没有强行制造 Windows PID 回收或访问权限拒绝。凭据 ACL 安装验收仍属于后续安装阶段。

## 后续依赖

T02–T07 尚未完成，当前 MCP 仍仅注册真实可服务的 `status`。本轮进程查询未发现运行中的 FiveM/FXServer；已向用户请求授权测试项目的绝对路径和桥接安装/启动范围。

RFC §16.1 要求先取得双端 Lua/JS 异步、会话隔离及日志唯一映射的真实宿主证据，再推进 FIFO 和业务工具。FiveM、FxDK、多客户端、框架、数据库、三 AI 客户端及发布包的验收均为 **NOT_EXECUTED**。本地假桥接和 stdio 测试不代替这些证据。
