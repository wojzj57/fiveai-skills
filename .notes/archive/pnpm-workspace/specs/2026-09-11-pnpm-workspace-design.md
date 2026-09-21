# pnpm workspace 与 FiveM 插件目录迁移

日期：2026-09-11  
状态：聊天方案已获批准；本文待用户审阅。  
RFC 输出目录：`notes/rfcs/`

## 目标与范围

使用 pnpm 统一管理仓库，将 `mcp/` 移到 `packages/mcp/`，将
`resources/fiveai-mcp/` 移到 `packages/fivem-plugin/`。两个包各自声明依赖和
构建入口，根目录提供统一命令。本次不改变调试功能、协议语义或安全策略。

保留当前工作区内已修改和未跟踪的开发文件，迁移基于工作区实际内容进行。
不以 Git HEAD 覆盖这些内容，不包含提交、推送、发布或实际服务器部署。
`skills/`、宿主插件元数据及其他无关目录维持原用途。

## 仓库证据

- 根 `package.json` 当前通过 `npm --prefix mcp` 调用 MCP 测试和资源构建。
- `mcp/package.json` 的包名为 `fiveai-mcp`，同时负责合约、entry、broker 和资源构建。
- `mcp/scripts/build-resource.mjs` 从 `resources/fiveai-mcp/` 读源码，显式借用
  `mcp/node_modules/`，生成资源内的 bundle，再复制到 `mcp/dist/fiveai-mcp/`。
- `mcp/tests/resource.test.ts` 和 Lua fixture 直接引用资源源码路径。
- FiveM 客户端、服务端及 Lua 执行器使用 `GetCurrentResourceName()` 生成事件前缀。
- MCP 和 bridge 的握手 build ID 使用 `fiveai-mcp/0.1.0`；配置键使用 `fiveai_mcp_*`。
- 当前环境实际返回 pnpm `11.9.0`、Node.js `v22.22.1`。这里只核实工具可调用，
  尚未验证迁移后的依赖安装与构建。
- 仓库没有 `.codegraph/`，本次通过文件检查定位引用。

## 方案选择

采用两个独立构建包的 pnpm workspace。相比只搬目录、继续由 MCP 构建资源，
该方案消除资源对 MCP 依赖目录的隐式借用，使部署产物由资源包自己维护。
不引入额外任务编排框架、公共工具包或发布系统。

## 目录与依赖

```text
ex-fiveai/
  package.json
  pnpm-workspace.yaml
  pnpm-lock.yaml
  packages/
    mcp/
      package.json                 # name: fiveai-mcp
      src/
      tests/
      dist/                        # MCP 构建产物
    fivem-plugin/
      package.json                 # name: fivem-plugin，private: true
      scripts/build-resource.mjs
      fxmanifest.lua
      client/
      server/
      shared/
      dist/                        # 开发目录中的 server.js、client.js
      artifact/fivem-plugin/       # 可复制部署的完整资源目录
```

workspace 仅包含 `packages/*`。根包继续为私有管理包，并设置
`packageManager: pnpm@11.9.0`，以当前可用版本为迁移基准。
使用一个根 `pnpm-lock.yaml`，替换现有 `mcp/package-lock.json`。
`skills-lock.json` 是技能工具数据，保留。

MCP 现有依赖及版本约束保留；资源包显式声明 `ws: 8.21.3` 和构建开发依赖
`esbuild: 0.28.2`。这两个依赖仍为 MCP 所需，不能从 MCP 包直接移除。
资源构建按本包依赖解析，不使用指向兄弟包 `node_modules` 的 `nodePaths`。
两包不添加仅用于构建排序的虚假运行时依赖。

## 构建与根命令

- `pnpm install`：安装整个 workspace；自动化验证使用冻结锁文件安装。
- `pnpm build`：构建 MCP 和 FiveM 插件，任一失败均返回非零状态。
- `pnpm build:resource`：只调用 `fivem-plugin` 的构建入口。
- `pnpm test`：运行原有根测试，保留当前命令的含义。
- `pnpm test:mcp`：先构建资源，再运行 MCP 的类型检查、构建和现有测试。
- `pnpm test:all`：依次运行根测试和 `test:mcp`。
- `pnpm validate`：保留现有插件校验入口。

MCP 自身的 build 只生成 `dist/index.mjs`、`dist/entry.mjs` 和
`dist/broker.mjs`。资源相关集成测试暂留 MCP 测试目录，由根 `test:mcp`
显式准备资源；直接运行 MCP 包测试需要先构建资源，该前提写入开发说明。

资源包保留现有服务端 CJS、客户端 IIFE、Node.js 22 和客户端无运行时 import
的构建约束。先生成本包 `dist/server.js` 和 `dist/client.js`，随后组装
`artifact/fivem-plugin/`，内含 `fxmanifest.lua`、`shared/executor.lua`、
`dist/server.js`、`dist/client.js` 和资源 README。部署目录不依赖工作区链接
或仓库中的 `node_modules`。构建失败不得报告产物已就绪。

`dist/` 与 `artifact/` 加入精确的忽略规则。新构建不再生成旧路径产物；
历史生成文件的清理由实现阶段先确认路径和归属，不能递归删除用户源码。

## 命名与兼容边界

FiveM 资源目录及私有 workspace 包名改为 `fivem-plugin`，部署说明使用
`ensure fivem-plugin`。资源显示日志可更新为新资源名。

MCP 包名、MCP server identity、握手 build ID、管道命名、`fiveai_mcp_*`
配置键、验证命令和机器可读日志标记保持原值。资源包名称不替代协议 build ID。

资源内部事件前缀随 `GetCurrentResourceName()` 自动变为 `fivem-plugin:`；
JS 和 Lua 测试桩及事件断言同步更新。这是部署资源重命名的必然变化，
不额外提供旧前缀别名。更新部署说明时要求停止旧资源，再启动新资源，
避免两份调试桥同时运行。

## 引用与文档迁移

修正构建脚本、测试、Lua fixture 的相对路径和根目录推导，检查 MCP
entry/broker 对自身 `package.json` 与产物路径的定位。
更新当前开发及部署说明中的源码路径、MCP 启动路径与 npm 开发命令。
README 中面向技能用户的 `npx skills` 安装示例保持原有用途。
历史 spec、RFC 和报告作为历史证据保留；当前迁移文档说明新旧路径映射。

## 验收标准

1. 两个源码目录位于目标路径；已修改和未跟踪文件均得到保留。
2. 根冻结锁文件安装成功，只有一个 Node.js 依赖锁文件；未借用 MCP 的
   `node_modules` 即可构建资源。若依赖生命周期脚本被阻止，只为已核实需要的
   依赖配置最小允许范围，不全局放开。
3. 根构建、根测试、MCP 类型检查与测试、插件校验均成功；失败需要区分迁移
   回归和原工作区问题，不能通过删除或跳过已有测试取得通过。
4. 资源部署目录文件完整，客户端无运行时 import，服务端外部依赖满足原有
   可独立部署约束。现有 VM/WS 集成测试使用新资源名通过。
5. Lua fixture 在已有 Lua 5.4/lupa 环境可用时运行；不可用时明确标记
   NOT_EXECUTED，不能视为通过。
6. 检查活动代码、脚本与当前文档，不残留旧目录引用；允许保留上述协议身份
   及历史文档中的旧名称。
7. 真实 FiveM 验收独立记录：加载 `fivem-plugin`、bridge 握手、客户端绑定与
   执行器冒烟。没有可用或获授权的宿主时标记 NOT_EXECUTED；构建和模拟测试
   不等同于宿主验收。

## 风险与后续

主要风险是 pnpm 依赖隔离暴露隐式引用、资源名变化导致测试事件不一致、
路径深度变化破坏 fixture，以及迁移覆盖当前未提交内容。上述依赖归属、
命名边界、路径检查和验收标准分别覆盖这些风险。

本文尚未执行安装或测试，因此没有实现通过的结论。用户审阅本文后，
交由 `technical-design-doc-creator` 在 `notes/rfcs/` 生成一个实现就绪 RFC，
源设计保留。本次设计阶段不执行目录迁移，不创建 Git 提交。
