# FiveAI MCP 一体化产物设计

日期：2026-09-11

状态：用户已确认交付方向、凭据位置与打包配置策略；本文件待最终设计确认。尚未实施。

## 目标与已确认决定

用户下载一个 `fiveai-mcp` 产物，即获得可安装的 FiveM 资源和桌面 MCP。

- 源码继续分为 `packages/mcp` 和 `packages/fivem-plugin`，交付时合并。
- `build` 与 `pack` 是两个命令：前者生成目录，后者构建并生成 ZIP。
- 用户预装 Node.js，包内携带完整 JS 运行依赖，不要求用户安装 npm/pnpm 依赖。
- 插件内 `mcp/` 携带 MCP JavaScript 和默认 `config.json`。
- 桌面 MCP 和 FiveM 服务端使用同一份配置，用户无需另行创建配置或复制 token 到 convar。
- 桌面入口首次启动时自动生成独立的 `entryToken` 和 `bridgeToken`，保存到插件内 `mcp/credentials.json`；以后复用。
- FiveM 先启动时等待凭据，在 MCP 初始化后自动连接。
- 重复 build 保留已有配置、凭据和运行状态。
- ZIP 使用仓库默认配置，不包含用户凭据、用户修改后的配置或运行状态。

## 当前实现依据

- 根 `package.json` 的 build 分别构建两个包，没有 ZIP 打包命令。
- `packages/fivem-plugin/scripts/build-resource.mjs` 删除整个暂存资源目录后重新复制文件；这一做法不能用于保留用户状态的新统一输出目录。
- `packages/mcp/src/cli/entry.ts` 目前强制要求 `--config`。
- `packages/mcp/src/cli/config.ts` 目前只读取已有凭据，不会创建凭据。
- `packages/mcp/src/protocol/config.ts` 当前要求 Windows 绝对路径，必须调整才能支持可搬移产物。
- `packages/fivem-plugin/server/main.js` 当前从 convar 读取 URL/token，并在启动时决定是否允许连接；必须增加文件读取与等待初始化流程。
- MCP 当前仅开放 `status`，本设计不增加执行、日志或框架工具。

## 建议的完整交付契约

以下具体路径和默认值随本文件一起提交用户确认。

```text
dist/
├─ fiveai-mcp/
│  ├─ fxmanifest.lua
│  ├─ README.md
│  ├─ dist/
│  │  ├─ server.js
│  │  └─ client.js
│  ├─ shared/
│  │  └─ executor.lua
│  └─ mcp/
│     ├─ entry.mjs
│     ├─ broker.mjs
│     ├─ config.json
│     ├─ credentials.json  # 首次运行生成，不进入 ZIP
│     └─ state/            # 运行状态，不进入 ZIP
└─ fiveai-mcp.zip          # 仅 pack 生成，内部只有一个 fiveai-mcp 根目录
```

对外使用 `pnpm run build` 和 `pnpm run pack`。后者是项目脚本，不是 pnpm 内置的 `pnpm pack` npm 包归档命令。

用户将 `fiveai-mcp/` 放入 FiveM/FxDK 项目，AI 的 stdio 命令为 `node <安装目录>/mcp/entry.mjs`。桌面最低 Node.js 版本保持 `>=22.12.0`。资源 manifest 继续选择服务端 Node 22。

### 默认配置与路径

建议随包提供：

```json
{
  "version": 1,
  "broker": { "host": "127.0.0.1", "port": 43189 },
  "stateDir": "./state",
  "credentialFile": "./credentials.json",
  "clientLogDir": null,
  "serverLabel": "local-fivem",
  "verifyEnabled": false
}
```

- 默认配置基于其所在的 `mcp/` 目录解析相对路径，不依赖进程工作目录或开发者机器路径。
- `entry.mjs` 无参数时读取入口旁的 `config.json`。保留显式 `--config <绝对路径>` 以支持现有桌面调试与测试；一体化安装使用无参数入口，确保两端读取同一文件。
- FiveM 服务端根据真实资源目录定位 `mcp/config.json`，不会执行桌面 entry/broker 文件。
- 默认凭据和状态均位于包内。路径规范化、文件归属与链接检查不能因支持相对路径而取消。
- `clientLogDir: null` 表示尚未配置日志来源，不妨碍当前 status/固定探针；将来的日志工具必须明确报告缺少来源，不能把 null 当成已完成自动发现。
- 固定探针默认关闭。用户将 `verifyEnabled` 改为 true 并重启资源后使用。
- 一体化包不要求上述三个 convar；连接参数与探针开关以 JSON 为准。
- 配置更改通过重启对应进程生效；地址/凭据路径变更需同时重启桌面 MCP/broker 和 FiveM 资源，不增加热更新协议。
- 保持 Windows 本机、回环地址、同一用户一次一个服务器环境的既有范围，不扩展为远程连接或并行多服。

### 凭据生命周期

1. entry 读取并验证配置，确认目标路径可用。
2. 凭据存在时严格验证并复用；损坏、不可读或格式不合法时报告错误，不能自动覆盖或轮换。
3. 凭据缺失时使用 Node `crypto.randomBytes(32)` 分别生成两个独立 token，使用 Base64 编码。
4. 通过并发安全的初始化流程发布完整文件；多个 AI 同时首次启动必须只产生一份有效凭据，竞争失败者读取胜出文件。
5. 文件访问限制延续现有 RFC 的当前用户/管理员读取边界；不把 token 写到 stdout、日志、构建产物或客户端下载清单。
6. 完整凭据就绪后发现或启动 broker。
7. FiveM 服务端只读取凭据，不生成第二份。缺失时以有界重试和限频诊断等待，不阻塞宿主 tick；就绪后自动连接。

凭据读取、校验和初始化的规则应共用可测试的模块，避免两端对相同文件作出不同解释。权限失败和配置损坏与正常的“尚未初始化”等待需要区分。

### 构建、打包与升级

- 先在干净暂存区成功构建完整程序文件，再更新统一输出；失败时非零退出，不能报告新产物成功。
- build 只管理明确列出的程序文件。已有 config、credentials 和 state 保留原内容；配置缺失才复制默认值。
- 不对统一输出根目录执行无差别递归清空，不从现有凭据生成发布包内容。
- pack 必须构建当前源码；ZIP 从本次干净程序产物、仓库默认配置和明确允许的文档组装，采用文件白名单。
- pack 不得把默认配置回写覆盖本地 build 目录的用户配置。
- 在构建成功后生成临时 ZIP，成功才发布最终 ZIP；不能把失败前遗留 ZIP 当成本轮成功结果。
- 包内不能依赖源码工作区、兄弟包 node_modules 或启动时下载依赖。
- 普通 ZIP 解压工具没有“保留 config”契约。文档明确升级时先停服务，解压到临时目录，再更新程序文件，保留原安装的 config/credentials/state；本轮不增加自动安装器。
- 已运行的 build 输出不作为热部署目标；本轮不承诺更新运行中的 broker/资源。用户停止相关进程后再构建或升级。

### FiveM 与 FxDK 使用方式

- 普通 FXServer：将完整目录安装为 `fiveai-mcp`，配置 `ensure fiveai-mcp`。
- FxDK：将完整资源目录放入项目并启用，无需另外配置 broker URL 或 token。
- AI 配置中只填写本地 Node 命令和 entry 路径。
- 启动顺序不影响最终连接：AI 先启动则建立 broker 等待资源；资源先启动则等待凭据和 broker。
- 不将 `mcp/**` 加入 manifest 的 `files`、`client_scripts`、`shared_scripts`；客户端下载只包含所需游戏脚本。
- FxDK 自动重启对 mcp/credentials/state 写入的响应必须在真实宿主验证。若文件写入触发重启，首版操作说明要求关闭该资源的 A 自动重启开关，改为修改代码后手动重启；不能默默改变用户的 FxDK 项目设置。

## 验收

自动化需要证明以下行为，而不只是目录存在：

1. build 与 pack 分别生成约定产物；ZIP 根目录和文件白名单正确。
2. 修改本地配置并放入测试凭据、状态后再次 build/pack，原文件逐字节保留；ZIP 仍是默认配置，无凭据或状态。
3. 将 ZIP 解压到与源码无关、带空格的目录，仅使用预装 Node 完成 MCP initialize、tools/list 和 status；无需 node_modules，工具仍只有 status。
4. 无参数默认配置从 entry 位置解析，随机 cwd 不改变行为；旧显式配置测试继续覆盖。
5. 首次启动生成凭据，重复启动复用，并发初始化一致；损坏、权限错误、链接、写入中断均不会静默替换既有凭据。
6. FiveM 服务端先启动并等待，再出现凭据/broker 时连接；游戏客户端 bundle 不包含凭据读取或 Node 依赖。
7. 根插件校验、现有 MCP 测试与 Lua harness 保持通过。

真实 FxDK 和直接 FXServer 分别验证两种启动顺序、固定 server/client 探针、配置修改后重启、资源重命名适配、凭据/状态写入对热重启的影响，以及客户端实际下载内容。未执行时明确记录 NOT_EXECUTED，不能用 VM 或假桥接替代。

## 风险与范围边界

- 已使用的插件目录包含私有凭据，不能作为分发源；分发使用 pack 生成的 ZIP。
- 当前没有真实 FxDK 接受结果，文件权限、宿主文件访问和自动重启行为属于实施时必须验证的边界。
- 此改动改善安装体验，不代表已有 T02–T07 全部完成，也不修复 `status.clients` 当前为空的功能缺口。
- 现有 README、旧路径说明和 RFC 配置契约需要随实施同步更新；历史验证报告保留历史属性。

最终确认后，按设计流程在 `notes/fivem-mcp/rfcs/` 形成实现契约，再进入开发。
