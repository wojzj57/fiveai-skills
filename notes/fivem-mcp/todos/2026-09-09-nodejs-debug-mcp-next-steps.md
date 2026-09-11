# Node.js Debug MCP 下一步开发任务

基线：2026-09-09 工作区，HEAD d8d84c05 加当前未提交改动。依据：[RFC](../rfcs/nodejs-debug-mcp-rfc.md)、[本轮审查](2026-09-09-nodejs-debug-mcp-review.md)。下列均为待完成任务；没有指定虚构负责人，没有在本轮实施。

**下一步直接执行 T01：闭合 broker 基础切片。** 然后先做 T02 的宿主可行性验证，再增加 FIFO 和框架能力。当前已有源码应继续使用，旧报告中“重建 stdio/broker”的指令不再适用。

## T01 · 修复现有 broker 缺陷并闭合第一阶段

前置：当前工作区；范围：mcp/src/cli、broker、必要协议声明及对应测试。

- [ ] F1：双方握手后验证 brokerInstanceId/sessionId 与连接绑定，实施角色消息清单；拒绝重复 welcome/hello 与旧代际消息。
- [ ] F2：合法 pending 恢复记录明确报告阻塞；区分文件健康与任务解决状态，展示原 taskId。
- [ ] F3：实现配置真实路径、最近存在祖先、junction/symlink 归属及固定内部文件检查；摘要基于规范化配置。
- [ ] F4：把 token、Host、Origin 和回环地址校验移到 HTTP 升级前；hello 保留协议与构建协商。
- [ ] F5：区分桥接自报进程身份与本机核验结果；不能核验时标记不可验证，不能直接相信 true。
- [ ] 确认 adapterDigest/buildId 的兼容策略；真实适配清单落地前如实标识未实现，不把任意 digest 当已验证兼容。
- [ ] 补宽限期内复用、停止期间新入口、启动失败释放句柄、帧容量和反复重连失败用例；检查重连定时器能否重复调度和在关闭后残留。
- [ ] 核查 lifetime pipe 释放与服务停止顺序：新实例出现前旧实例必须停止接受工作；用测试覆盖不同端口配置在退出窗口竞争。

验收：现有 107 项 MCP 测试、根 11 项及插件校验继续通过；新增 F1–F5 反例在正确层级通过；10 个入口仅形成一个有效实例；不引入第二调度器。真实网络测试应分别证明“不升级”“不处理错误身份消息”，而非仅最终 socket 关闭。故障用例不得关闭与本次测试无关的既有 broker。

完成后记录：实际 Node 版本、测试命令、结果及本次源码基线。保留已有未提交内容，提交与交付另按实际授权处理。

## T02 · 验证 FiveM 双端执行和日志映射可行性

前置：T01；范围：新增 resources/fiveai-mcp、独立 Server/Client 构建及最小宿主测试资源；仅在已获操作授权的环境验证。

- [ ] fxmanifest 指定 Server Node 22；Server bundle 仅携带 ws 和桥接代码，Client bundle 不含 Node builtins/require/import。
- [ ] Server I/O 入站排队，由宿主 tick 执行 natives/exports；Server 执行入口不注册为客户端可触发的网络事件。
- [ ] 客户端握手绑定实际 source、随机 challenge、clientEpoch；结果验证 source、任务和当前目标身份。
- [ ] 双端 Lua load/xpcall/Citizen 协程与 JS await 最小闭环；原运行时编码 Lua 尾 nil、多返回和 JS undefined/BigInt/vector/错误。
- [ ] TS 片段 AST 约束、ES2020 转换、唯一虚拟文件和 source map；不安装运行依赖。
- [ ] 输出 session logMarker，验证普通 FiveM 与 FxDK 中当前客户端日志能唯一定位；共享文件无法证明归属时返回映射失败。

验收：FxDK 与直接 FXServer 各留版本、资源版本、输入、输出和日志证据；覆盖异步等待、跨语言错误、serverId 重用和多客户端隔离。真实环境未执行就标 NOT_EXECUTED，不能用假桥接替代。若线程/异步或日志归属路线不可行，先修订该路线，再继续后续功能。

## T03 · 全局 FIFO、任务状态与恢复

前置：T02 可行性证据；范围：scheduler、execution 分派、broker 任务链、远端任务缓存、queue 工具。

- [ ] 一条全局 FIFO；校验、目标绑定和必要确认后分配 sequence；最多 100 queued、1 running/unknown。
- [ ] 队首开始计时及编译；工具等待 20 秒返回 taskId，queued/running 不设 isError；timeout 不伪称终止远端。
- [ ] 只允许原入口取消 queued；入口失联取消 queued 与确认，保留 running/unknown。
- [ ] 下发前原子保存 dispatch_intent；核验终态后先 settled 落盘，再 resultAck 和下一任务。
- [ ] 迟到终态、重连状态查询、重复 dispatch 去重、完整结果缓存和摘要过期语义；不重放代码、不强制跳过 unknown。
- [ ] 资源生命周期恢复例外使用本机核验身份；不扩展到通用片段、框架或数据库调用。

验收：四个崩溃边界（写前、写后发前、发后 received 前、终态后 ack 前）故障注入；能证明单次副作用。跨 broker/bridge/client 代际、篡改结果、重复结果、写失败、结果过大均不错误推进；status/queue 控制读取在 unknown 时仍响应。

## T04 · 资源控制与日志闭环

前置：T03；范围：resource、logs、桥接采集、客户端文件 tail。

- [ ] resource list/status 使用 live/cached 标记；变更走 FIFO；restart 是同任务 stop→观察→start，不允许插队。
- [ ] 使用实际资源名保护桥接自身；starting/stopping 超时按 unknown，native 返回布尔值不等于完成。
- [ ] Server 控制台采集有界批次、背压与 droppedCount；不阻塞任务结果。
- [ ] Client marker 唯一映射、文件标识/偏移、轮转和截断重定位；不按最近修改文件猜测。
- [ ] 真实脱敏日志 fixtures：跨块 UTF-8、CRLF/ANSI、未知频道、正文同名资源、FxDK 转发、相同正文、多 marker 冲突。
- [ ] 全局/单流内存和响应限额；AND 过滤、最近 N 条升序展示、coverageStart/sourceGaps。

验收：在两个宿主下完成资源 restart、自身保护及日志筛选；对无法归属的客户端日志明确失败，不混合展示。

## T05 · 框架和 ox 方法清单

前置：T03；范围：data/adapters、桌面/执行端适配器、生成的 Skill 方法参考。

- [ ] 按 RFC §9 的固定源码基线核实首版 ESX/QBCore/ox_lib/ox_target/oxmysql 清单；桌面和执行端共同拒绝任意属性路径。
- [ ] 实现逐方法参数/返回契约、玩家快照、权限和目标约束；资源重启后重新解析框架对象。
- [ ] ox_lib 等待 UI 完成/取消；ox_target 稳定 name、JSON options 和资源归属，不保证删除其他资源内容。
- [ ] oxmysql 映射 method_async 并等待 Promise rejection；保留绑定参数，不拼接 SQL；需确认能力由 T06 完整接入后开放。

验收：每个首版方法有契约测试，ESX/QBCore 各自测试环境及 ox 库提供实际结果；资源缺失、重启、玩家离线和不支持方法分别失败。方法参考与生成源保持一致。

## T06 · SQL 分类与原请求确认

前置：T03、T05 的 oxmysql 通道；范围：SQL AST、approval 生命周期、entry elicitation。

- [ ] 仅 RFC 允许的单 SELECT AST 子集免确认；未知节点/函数、CTE、锁、可执行注释及写入/事务均确认。
- [ ] 完整展示原 SQL 和全部参数；超过可靠展示上限拒绝，不截断批准。
- [ ] 摘要绑定 method、SQL、参数、原 entry、服务器/桥接身份和 oxmysql generation；批准后队首再次校验。
- [ ] 在原始工具调用上下文 elicitation；仅 accept 且 confirm=true 执行，一次消费、不持久化批准。
- [ ] decline/cancel/超时/断线/不支持 form 均不执行；普通工具参数不能携带 approved 绕过。

验收：AST 反例矩阵、修改参数/目标、资源重启、重复批准、审批上限；测试数据库写入只发生一次，超时不声称回滚。Codex/Claude/CodeBuddy 分别验证 form 能力与展示上限，不支持路径明确返回 APPROVAL_UNSUPPORTED。

## T07 · 资料、Skills 与发布包

前置：T04–T06；资料索引可在契约稳定后单独实施，完整发布仍依赖全部验收。

- [ ] 本地 native/event/guide 数据经核实并附来源、revision、license、条目数；稳定排序，无匹配才在线回退。
- [ ] 官方访问路径与重定向逐跳校验；树清单/文档数量/8 秒预算；限流和离线可解释，不持久化运行期线上资料。
- [ ] 新增 fivem-mcp 安装、凭据 ACL、调试、错误和恢复文档；新增 fivem-nui-debug、ox-target，生成框架方法参考副本。
- [ ] NUI 工作流只使用用户已有 CDT 能力；两种宿主找到正确目标并实测 console/DOM。
- [ ] 根构建入口和 files 清单携带桌面产物、资源及资料；保持现有插件名称、多宿主 metadata 和 DeepSeek 分发行为。
- [ ] 从实际发布包解包后启动，不依赖开发源码绝对路径或启动时下载；最终 tools/list 恰好 10 个，无截图、文件工具及旧 Prompts/Resources。

验收：根插件校验持续通过；发布包离线 reference 与 stdio 可用；三客户端连接、20 秒查询流程、确认能力及真实宿主矩阵填写 PASS/FAIL/NOT_EXECUTED。发布、部署及回退操作按相应授权执行，不因文档完成自动宣称发布完成。

## 开发完成的判定

只有契约、自动化、进程、真实宿主和发布包各自有证据后，才能更新对应阶段完成状态。当前 T01–T07 全部保持待完成；T01 已有大量可保留实现，T02–T07 不应仅靠新增文件或工具名称勾选完成。
