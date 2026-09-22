# RFC：HTTP MCP 从探针到完整调试服务的后续开发

日期：2026-09-22。状态：开发方案待审阅。本轮用户授权编写 RFC 与审查进度，不在本次文档工作中改运行代码、部署、重启或提交。

## 1. 目标与基线

目标是 FxDK 启动单个资源即可提供本机 HTTP MCP，AI 能查询状态、执行 Server/Client Lua 与 TS、管理资源、读取日志和调用框架。完整范围仍为 10 工具。

依据：[当前进度审查](../reports/2026-09-22-development-progress-review.md)、[基础 RFC](runtime-debug-mcp-rfc.md)、[契约附件](runtime-debug-mcp-contracts.json) 与 [无 Worker 修订](2026-09-22-no-worker-compilation-rfc.md)。优先级：本次明确决策及无 Worker 修订 > 本文件的实施顺序 > 基础 RFC 与附件；不得从旧 Broker RFC 拼接不一致规则。

默认产物当前仅有三个探针工具。HTTP、边界检查与发布保护有可用基础；任务中心、执行器、日志和框架不能因旧目录存在源码而计为完成。

此次改变实施顺序：先让一个正式调用贯穿 HTTP、队列、宿主和结果；取消“所有宿主门槛通过后才允许开发业务模块”。每项能力仍须验证，失败只阻止依赖它的交付范围，全部 10 工具的最终验收不缩减。

## 2. 代码边界与复用

沿用当前 `http-mcp/src/server.ts` 作为发布入口，在 `http-mcp/src/` 下按 http、tools、tasks、execution、logs、adapters、reference、shared 拆出实际模块；正式客户端 JS 与 Lua 放入同一 http-mcp 子树并由默认构建打包。本文件替代基础 RFC §2 的目标源码目录布局，不改变单包交付路径。先按切片提取需要的模块，不先做整个仓库搬家。

| 候选资产 | 使用规则 |
| --- | --- |
| 当前 HTTP transport、会话及边界校验 | 保留已通过的行为测试，再接入正式 handler/Schema |
| 当前 HostWork | 补齐 §2 的有界控制/执行调度、优先级和停止处理 |
| 旧 scheduler | 仅复用验证后的状态转换思想；重新实现独立活动队列与有界终态历史 |
| 旧 WireValue、UTF-8、大小检查 | 按当前 JSON Schema 对照复用，不以旧测试通过代替契约一致性 |
| 旧 JS/Lua 执行器 | 可提取函数体执行与编码；必须接新 binding、epoch、ack、去重及 unknown 规则 |
| 旧 Broker、管道、凭据与恢复存储 | 不进入默认产物依赖；无需先清理它们才能交付新入口 |

唯一工具定义同时关联名称、input/output Schema、handler。构建时缺 handler 即失败；不能先注册十个名称再用占位错误冒充实现。开发切片可只公开已实现工具并明确标为部分交付；正式包只公开完整十个工具，移除 native_read/compile_ts 探针工具。

## 3. 首个可用切片：服务端执行闭环

这是下一次实现的首要落点，不再单独交付一轮只测 Worker/模块导入的探针。

范围：无 Worker 编译、配置读取、正式 status/queue、server execute_lua/execute_ts、统一内存任务中心与结果编码。HTTP 默认路径、协议边界和会话行为保持；严格 config/config.json 使用基础 Schema，错误配置拒绝启动，探针环境变量不成为长期第二配置入口。

任务中心提供内部 `submit/get/cancel/recover/settle` 与 `dispatchCommitted` 边界。接受时分配 taskId/全局序号；队首准备，取消前置任务，派发后 timeout/目标失联进入 unknown 并暂停。恢复只接受同代匹配终态，无 force、无重放。活动队列不能从限长展示列表反查；终态淘汰不能删除活动任务。

Server Lua 与 JS 按函数体执行，等待 await/Citizen.Await 链；框架与 native 访问跨入 Host Tick。不注入业务资源，exports 按已有边界调用。终态必须区分未派发、已结束执行失败、已执行但编码失败和结果不明。源码位置通过编译 source map/包装偏移映射。

先同步更新编译、manifest、build 白名单和 artifact 测试，删除 Worker gate；继而把正式工具接入同一路由。第一切片 tools/list 只列 status/queue/execute_lua/execute_ts，并明确 client 路径尚未交付；不得返回伪造的客户端成功结果。

完成条件：

- 离线 HTTP 测试能提交任务、查到 taskId 与可信终态；Lua/TS 返回正确 WireValue，语法失败没有游戏副作用。
- 取消竞争、超时 unknown、可信迟到终态恢复、会话结束、队列容量与终态淘汰验证通过。
- 真实 FxDK 无 worker 权限启动；由 HTTP MCP 执行 server Lua/TS 并读取结果，停止后释放端口。
- 普通 JS 无 CommonJS wrapper 的加载测试与改名/空格路径验证通过；完成无 Worker RFC 的耗时测量。

这构成“服务端开发预览可用”，不构成完整十工具发布。

## 4. 第二切片：资源控制与服务端日志

resource 的 list/status 走有界 Host Tick 控制路径；start/stop/restart 走同一个 FIFO，精确名称、自身保护、阶段状态、30s 总期限和代际核验遵守基础 RFC §11.1。不得把 native 返回 true 当成资源最终就绪。

logs 首先实现 RegisterConsoleListener、有界 ring、channel/resource 归属、过滤后最近 N 条、raw 选择与 coverage。没有客户端日志来源时按基础契约返回 unconfigured/partial/unavailable，不能用 MCP 自身 console wrapper 冒充全部日志。

完成条件：真实 FxDK 对独立测试资源执行一次状态查询和受控重启，日志能查到该资源输出；自身 stop/restart 被拒绝；unknown 不推进队列。此时 AI 的“修改代码后重启资源并看服务端结果”主工作流可用。

## 5. 第三切片：客户端执行与日志归属

接入 server/client JS/Lua manifest 与下载白名单。实现 hello/bind、双方语言 ready、真实网络 source 校验、resourceEpoch/connectionId/clientEpoch、重复执行去重、终态缓存/ack/重发、heartbeat 与 ID 复用防护；直接遵守基础 RFC §7 和附件 InternalMessage。

客户端日志继续使用配置路径、随机绑定标记、唯一文件命中、增量读取与轮转/截断/缺口。先在目标 artifact 单独验证文件读取；失败允许继续客户端执行开发，但 logs 的客户端覆盖必须报告不可用，完整日志验收不通过。

完成条件：真实两个客户端分别执行 Lua/TS，断线重连、server ID 复用和迟到结果不会投递/结算到错误目标；有唯一绑定证据才返回对应日志。若宿主禁止读目录且无可用配置，单独提出日志方案修订，不加外部代理，不撤回整个执行链路。

## 6. 第四切片：框架、SQL 确认与资料

esx/qbcore/ox 采用基础 RFC §9 的固定版本与方法表，逐次取得当前对象，输出字段投影并经过 WireValue；方法不存在和依赖缺失是业务错误，不能作为正向验收。

SQL 分类器、form elicitation 和原会话请求关联按 §10：确认前不入 FIFO；批准内容完整且未过期，断流/会话失效/目标变化使批准失效；unsupported 确认能力直接拒绝写操作。不得以普通聊天同意或 approved 参数替代。

reference 实现固定版本离线 manifest 与受限在线回退；记录来源和许可，不接受用户拼接 URL。实现依照现有 allowlist 与预算，不为速度改成任意搜索。

完成条件：框架方法在相应测试环境有正向与失败证据；数据库在专用测试库核对批准/拒绝及真实副作用；AI 客户端分别验证初始化与 elicitation；离线命中不联网，在线失败保持结构化错误。

## 7. 第五切片：完整发布

构建默认产物覆盖 server/client/Lua、普通编译模块、config 示例、data、LICENSE/NOTICE。`pack` 实际生成单根 ZIP 与文件哈希清单，不能继续等同于 build。

补齐唯一 staging、独占发布锁和异常恢复验证；保留现有 config 与未知文件拒绝策略。所有构建/打包测试在 fixture 运行，禁止覆盖已挂载默认产物。切换正式产物在资源停止后执行，构建本身不启停宿主。

正式验收包括恰好十工具、输入输出 Schema、无占位 handler、ZIP 解压后无 workspace node_modules 可启动、真实 FxDK 及直接 FXServer、客户端/框架/数据库/日志、Codex/Claude Code/CodeBuddy 各自证据。没有执行的项目标 NOT_EXECUTED，不以其他环境的通过代替。

## 8. 依赖顺序与推进规则

| 切片 | 前置 | 可交付价值 | 局部阻塞影响 |
| --- | --- | --- | --- |
| 1 服务端闭环 | 当前 HTTP 基线 | AI 运行 server Lua/TS 并查询结果 | 编译加载问题影响 TS；Lua/任务中心可继续实现 |
| 2 资源与服务端日志 | 1 的任务中心/Host 调度 | 重启业务资源并查日志 | 不等待客户端目录权限 |
| 3 客户端 | 1 的任务/执行契约 | client Lua/TS 与归属日志 | 客户端日志权限只阻止该能力验收 |
| 4 框架/SQL/reference | 1 的调度/会话；client 方法依赖 3 | 完整调试工具 | SQL 确认问题不阻止 reference 或只读框架开发 |
| 5 发布 | 全部切片 | 可安装的完整单资源包 | 未通过能力明确阻止完整发布 |

每次进度报告展示“默认发布入口里实际能调用什么”、新增端到端证据、剩余缺口和 PASS/FAIL/NOT_EXECUTED。先运行变化对应测试及必需检查，不反复跑无关旧 Broker 全套测试来替代业务完成度。

遇失败先判断属于实现缺陷、配置缺失还是契约不可行；前两类修复后复验，只有需要改变产品能力/信任边界时才修订设计。禁止因局部门槛失败反复重启完整设计流程。

## 9. 风险、回退与待确认事项

无 Worker 的同步阻塞是明确取舍，测量和返回后预算检查见专门 RFC。旧模块契约漂移通过当前 Schema 与发布入口集成测试拦截；游戏代码死循环、未 await 副作用和资源重启不回滚外部操作的边界继续存在。

每个切片在隔离 fixture 验证，部署失败可恢复上一已验证构建并重启资源；这会丢弃内存任务/会话，不能声称恢复或撤销已执行副作用。不得自动重放任务。

没有新增产品方向问题：用户已明确单资源 HTTP、不要 Worker。待取得的证据是普通编译模块真实加载、同步编译延迟、客户端文件权限与各运行端验收；这些按上述切片处理，不要求用户先提供所有结果才能开展开发。
