# Native JavaScript 与客户端启动修复

2026-09-22 用户明确要求修复客户端 `TextEncoder` / Lua `SetInterval` 启动错误，并将 `execute_ts` 替换成 `execute_js`。本记录中的新要求覆盖此前 RFC 的 TypeScript 运行时编译方案；原 RFC 保留为历史记录。

## 变更

- 客户端 UTF-8 长度统计复用不依赖浏览器全局对象的实现。客户端入口使用 FiveM `GetGameTimer`，不依赖 `performance`。
- Lua 重发和缓存维护改为 `SetTimeout` 循环，资源停止后不再调度。
- 唯一 JS 工具为 `execute_js`；不保留 `execute_ts` 别名。公共工具表、Schema、任务类型、客户端分发、基准脚本与测试同步迁移。
- ES2022 JavaScript 由宿主原生执行，支持 `args`、`return`、`await`。Acorn 仅检查 JavaScript 语法，不进行转译；TypeScript 类型标注、模块导入导出及直接 require 调用在派发前拒绝。
- 首次执行在 Host Tick；await 之后访问服务端 native/exports 必须通过同步 `mcp.host(callback)`。服务端和客户端提供同一显式接口，不承诺自动转换任意异步回调。
- 删除运行时 TypeScript 编译模块及编译器文件构建步骤。TypeScript 仅作为项目开发期类型检查工具保留。
- `status.compiler` 替换为 `status.javascript`，值为 `{mode:"native",syntax:"ES2022",hostAccess:"explicit"}`；JS 语法错误使用 `JAVASCRIPT_INVALID`，Lua 保留原有 `COMPILE_FAILED`。
- 保留此前配置读取修复：Host Tick 上通过 `LoadResourceFile` 读取资源配置。

## 验证

| 检查 | 结果 |
| --- | --- |
| 两处真实启动错误对应回归 | 先 FAIL，修复后 PASS |
| HTTP MCP 类型检查及全量 Node 测试 | PASS，86/86 |
| 公共工具、注册表、协议消息检查 | PASS，41/41 |
| Lua 5.4 服务端执行检查 | PASS，13 个用例及适配器替身 |
| 无浏览器全局对象的客户端完整入口 | PASS，hello、绑定、执行、Host Tick 回调及终态 |
| Node 文件读取受限时的 JS 执行 | PASS，无运行时编译器加载 |
| 独立 ZIP | PASS，25 文件，254781 字节，无 compiler CJS / TypeScript 运行时包，包含 Acorn 许可证 |
| 新包真实 FxDK 重载、客户端 JS/Lua 与客户端日志 | NOT_EXECUTED，等待替换资源后验证 |

构建 ID：`984cba0503fb0a98fa358c25cef0afeb7c4a4da4ef96f729d602400725bd5fb3`。

客户端文件日志仍要求成功绑定、配置真实日志目录、唯一标记与宿主读取权限。修复启动失败不等于已经验证客户端文件日志。同步死循环不能被执行超时强行中断；unknown/FIFO 暂停与证据恢复规则保持不变。
