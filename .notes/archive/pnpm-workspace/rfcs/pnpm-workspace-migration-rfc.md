# RFC：pnpm workspace 与 fivem-plugin 迁移

状态：提案，待实现；来源设计已由用户批准。  
日期：2026-09-11  
来源：[已批准的迁移设计](../specs/2026-09-11-pnpm-workspace-design.md)

## 决策与目标

将 `mcp/` 迁移到 `packages/mcp/`，将 `resources/fiveai-mcp/` 迁移到
`packages/fivem-plugin/`。根目录用 pnpm workspace 和单一锁文件管理两个包，
各包独立声明依赖和构建入口。FiveM 部署资源名为 `fivem-plugin`，MCP 包名
继续为 `fiveai-mcp`。

迁移成功意味着：根目录可安装、构建、测试和校验；资源包不再借用 MCP 的
依赖目录；完整资源产物可脱离仓库部署；现有协议行为和工作区开发内容保留。
不扩展调试功能，不引入新构建框架，不发布包，也不迁移 broker 持久化数据。

## 当前行为与证据

以下路径是迁移前位置：

| 位置 | 当前行为及影响 |
| --- | --- |
| `package.json` | 根脚本通过 `npm --prefix mcp` 分派任务 |
| `mcp/package.json` | `fiveai-mcp` 同时构建合约、entry、broker 和资源 |
| `mcp/scripts/build-resource.mjs` | 读取外部资源源码，用 `nodePaths` 借用 MCP 的依赖，产物复制到 `mcp/dist/fiveai-mcp/` |
| `mcp/tests/resource.test.ts` | 从旧资源目录加载源码与 bundle，模拟资源名为 `fiveai-mcp` |
| `mcp/tests/fixtures/lua-executor-check.py` | 按固定目录深度定位仓库并加载 Lua 执行器 |
| `mcp/tests/process/broker-process.test.ts` | 用相对自身文件的路径定位 MCP 包根 |
| `mcp/src/cli/entry.ts` | 按源码或 bundle 位置定位 broker |
| `mcp/tsconfig.json` | 注明测试需要 Node >=22.18.0，产物运行时底线为 >=22.12.0 |

当前工具环境已核实为 pnpm 11.9.0、Node.js 22.22.1。该事实仅用于选定迁移
基准，不代表新布局已通过安装或测试。工作区存在修改和未跟踪源码，不能用
仅包含已提交文件的 checkout 代替迁移输入。

## 工作区和依赖契约

根 `package.json` 保持私有，设置 `packageManager` 为 `pnpm@11.9.0`。
`pnpm-workspace.yaml` 的包集合精确为 `packages/*`。
根维护唯一 `pnpm-lock.yaml`；移除迁移范围内的 `package-lock.json`，保留
与 Node 依赖无关的 `skills-lock.json`。参考目录和历史材料不加入 workspace。

| 包目录 | package name | 依赖归属 |
| --- | --- | --- |
| `packages/mcp` | `fiveai-mcp` | 保留现有依赖及版本约束 |
| `packages/fivem-plugin` | `fivem-plugin` | 私有包；`ws: 8.21.3` 为依赖，`esbuild: 0.28.2` 为开发依赖 |

资源包使用 ESM 构建脚本，声明 `type: module`；部署产物不复制其
`package.json`，避免改变现有 CJS 服务端 bundle 的宿主加载方式。
不添加两包间仅用于排序的运行时依赖，不启用提升依赖来掩盖缺失声明。
保留 MCP 的运行时 Node engines；开发验证使用已核实的 Node 22.22.1。

首次生成锁文件应尽量保留现有 npm 锁中的解析版本；任何无法保留的传递依赖
变化必须在实现报告说明原因。首次安装后再执行冻结锁文件安装验证可重复性。
依赖构建脚本若被 pnpm 阻止，先定位具体依赖，仅允许构建所需的已核实项。

## 命令契约

下表是拟写入根 `scripts` 的命令；通过 pnpm 执行，`&&` 在前一步失败时停止。

| 根脚本 | 内容 |
| --- | --- |
| `build` | `pnpm --filter fiveai-mcp run build && pnpm --filter fivem-plugin run build` |
| `build:resource` | `pnpm --filter fivem-plugin run build` |
| `test` | 保留现有 `node --test "tests/**/*.test.mjs"` |
| `test:mcp` | `pnpm run build:resource && pnpm --filter fiveai-mcp run test` |
| `test:all` | `pnpm run test && pnpm run test:mcp` |
| `validate` | 保留 `node scripts/validate-plugin.mjs` |

MCP 的 `build` 依次通过 pnpm 调用现有 `build:contracts`、`build:entry`、
`build:broker`；删除包内资源构建职责。其 `test` 依次执行 `typecheck`、
`build` 和现有 Node 测试命令，避免递归调用根测试。

资源包 `build` 执行 `node scripts/build-resource.mjs`。
资源集成测试继续放在 MCP 中，因此直接执行 MCP 包测试需要事先构建资源；
标准开发入口是根 `pnpm test:mcp`。当前不为目录迁移重新划分整个测试体系。

## 产物与构建隔离

MCP 产物仍为包内 `dist/index.mjs`、`dist/entry.mjs`、`dist/broker.mjs`。
资源构建脚本移动到 `packages/fivem-plugin/scripts/build-resource.mjs`，
相对脚本定位本包根，从本包解析 `esbuild` 和 `ws`，移除兄弟包 `nodePaths`。

保留服务端 Node 22/CJS、客户端 ES2020/IIFE 的构建设置，以及可选原生模块
`bufferutil`、`utf-8-validate` 的现有 external 与禁用设置。
客户端通过 metafile 检查没有运行时 import。服务端 bundle 包含必需的 `ws`
实现，部署不依赖 workspace 链接或外部 `node_modules`。

开发 bundle 写入 `packages/fivem-plugin/dist/`。完整部署目录是
`packages/fivem-plugin/artifact/fivem-plugin/`，内容如下：

```text
fivem-plugin/
  fxmanifest.lua
  README.md
  shared/executor.lua
  dist/server.js
  dist/client.js
```

任一构建、客户端 import 检查或文件复制失败均退出非零，不输出就绪信息。
仅成功组装的目录可部署；失败后现存产物视为无效，不因目录存在判定成功。
忽略规则覆盖两个包的 `dist/` 和资源包 `artifact/`。

## 命名与兼容契约

| 项目 | 决策 |
| --- | --- |
| 资源目录与启动命令 | `fivem-plugin` / `ensure fivem-plugin` |
| MCP 包名及 server identity | 保留 `fiveai-mcp` |
| 握手 build ID | 保留 `fiveai-mcp/0.1.0`，不由新资源包名推导 |
| broker 管道名称和持久化格式 | 保留 |
| convar、验证命令、机器可读日志标记 | 保留 `fiveai_mcp_*`、现有验证命令和标记 |
| 资源事件名称 | 保留按实际资源名动态生成，部署后为 `fivem-plugin:*` |
| 旧事件前缀兼容 | 不提供别名；资源客户端、服务端和 Lua 一并切换 |

资源可读日志前缀更新为 `fivem-plugin`，协议身份不做全局字符串替换。
现有认证、私有 token、绑定检查及执行去重逻辑保持原样；配置和密钥不复制
进部署包。本次没有新的持久化数据迁移或身份转换。

## 路径消费者

- 资源测试从 `packages/mcp/tests/` 使用 `../../fivem-plugin/` 定位源码和
  开发产物，动态 import 同步更新。测试桩的资源名、事件断言及停止事件参数
  更新为 `fivem-plugin`。
- Lua fixture 从新位置以 `Path(__file__).resolve().parents[3]` 定位
  `packages/`，随后读取 `fivem-plugin/shared/executor.lua`；变量命名体现
  该目录是 packages 根。其模拟资源名与事件键同步更新。
- process 测试相对 MCP 包内位置未改变，保留包根推导并验证产物可启动。
- `src/build.ts` 的包版本定位、entry 的 broker 定位均须通过源码和 bundle
  路径检查；不能靠版本回退常量掩盖目录错误。
- 当前文档中的启动入口更新为 `packages/mcp/dist/entry.mjs`，部署说明使用
  新 artifact 路径。npm 开发命令更新为 pnpm；用户安装技能的 `npx skills`
  示例保留。历史 notes 不作追溯重写。

## 实施顺序和回退

这些步骤属于同一个可验证的迁移单元，不将中间的失效布局作为交付结果。

1. 记录工作区修改与未跟踪文件清单，保存迁移源码的相对路径和内容校验值，
   区分源码、安装目录和构建产物。先记录现有相关测试基线。
2. 在确认绝对源路径和目标路径均位于本仓库、且目标无冲突后迁移两个目录，
   保留全部开发内容。不要把旧 `node_modules` 链接当作新布局的有效安装。
3. 调整 workspace、包依赖、构建归属、命令、路径消费者与文档。
4. 生成统一锁文件，执行验证矩阵，核对迁移清单。源码内容变化仅限明确的
   迁移编辑；报告其他差异。保留现场以诊断失败。

回退只撤销本次迁移的编辑，并将文件按映射迁回原目录；先检查目的地是否
已有新文件。恢复原锁文件和脚本必须使用迁移前工作区内容，不能使用
`git reset --hard` 或清理未跟踪文件。删除安装/产物目录前验证绝对路径及
归属，避免跨出仓库或删除源码。

实际服务器部署不在本次设计交付中。未来部署时先停止旧资源，复制完整新
产物，再更新启动配置并加载新资源。握手或客户端绑定失败即停止新资源，
恢复原资源和启动配置；不得同时运行两份桥，也不删除 broker 恢复数据。

## 验证矩阵

| 检查 | 入口或证据 | 成功标准 |
| --- | --- | --- |
| 依赖安装 | 根 `pnpm install` 后 `pnpm install --frozen-lockfile` | 安装成功，冻结安装不修改锁文件 |
| 两包构建 | 根 `pnpm build` | 两包产物生成，命令非零退出能阻断后续步骤 |
| 根测试及 MCP 测试 | 根 `pnpm test:all` | 根测试、类型检查、协议/进程/资源测试全部通过 |
| 插件校验 | 根 `pnpm validate` | 原有插件结构和技能校验通过 |
| 独立资源依赖 | 从干净安装环境调用资源包 build；检查无跨包 nodePaths | 资源解析来自本包声明，产物不依赖 MCP 安装目录 |
| 部署产物 | 检查完整文件集合并从 artifact 加载实际 bundle 做现有 VM/WS 冒烟 | 不只是测试源码 dist；握手、绑定、执行及客户端无 import 检查成功 |
| Lua fixture | `py -3 -X utf8 packages/mcp/tests/fixtures/lua-executor-check.py` | 已有 lupa/Lua 5.4 环境下执行通过；环境缺失记录 NOT_EXECUTED |
| 文件迁移 | 对照迁移前清单及批准编辑 | 没有丢失修改或未跟踪源码，目标路径正确 |
| 活动路径检查 | 搜索源码、脚本与当前文档 | 无旧目录引用；协议身份和历史文档按兼容表豁免 |
| FiveM 宿主 | 有可用且获授权的宿主时加载新资源 | 加载、握手、绑定和执行器冒烟通过；否则 NOT_EXECUTED |

迁移测试只增加能捕获行为回归的产物/路径验证，不以配置字符串快照代替运行
验证。不跳过既有失败；相同环境比较迁移前后结果，以确认失败归属。
最终按 PASS、FAIL、NOT_EXECUTED 报告；模拟测试通过不等于宿主验收通过。

## 风险与取舍

| 风险 | 缓解与检测 |
| --- | --- |
| pnpm 隔离暴露隐式依赖 | 显式声明资源依赖；干净安装后独立构建 |
| 新资源名与旧协议名混淆 | 按兼容表分项更新；真实 bundle 的事件及握手测试 |
| 固定目录深度失效 | 按上文定位规则更新 fixture，验证进程启动与 Lua 加载 |
| 脏工作区迁移丢文件 | 迁移前清单与校验值；回退基于工作区而非 HEAD |
| 不完整或旧产物被误用 | 构建失败非零退出，部署只接受成功构建的 artifact |
| 宿主环境未验证 | 明确独立宿主验收状态，不宣称模拟环境覆盖真实加载 |

只搬目录并保留 MCP 代建资源的方案改动更少，但继续保留隐式依赖归属；
已批准方案选择独立构建。引入任务编排框架的方案增加配置成本，两包规模下
没有必要。当前接受资源集成测试暂留 MCP 的小范围耦合，以控制迁移范围。

## 审核记录与剩余事项

已对照来源设计、实际包脚本、构建器、测试与路径定位逻辑检查契约、回退和
验收覆盖；来源设计文件保留原文，用户批准记录来自本次会话。
没有未决架构选择。依赖安装、构建、测试和宿主验收均留待实现阶段执行，
本文不声称这些检查已经通过。RFC 编写不授权提交、发布或部署。
