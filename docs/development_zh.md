# 开发

## 前置条件

- Node.js（具体版本见 `.tool-versions`）
- npm workspaces（随 Node 自带）

## 运行开发服务器

```bash
npm run dev:server
npm run dev:app
npm run dev:desktop
```

根目录检出（checkout）的开发环境有意拆分到不同终端：

- `npm run dev:server` 在 `127.0.0.1:6768` 上运行守护进程。
- `npm run dev:app` 在 `http://localhost:8081` 上运行 Expo 并连接到开发守护进程。
- `npm run dev:desktop` 在其自己的 Electron 风格 Expo 服务器上运行，使用从 `8082` 到 `8089` 的第一个空闲端口。它绝不会占用 `8081` 端口。

`npm run dev` 只是 `npm run dev:server` 的简写。将 `127.0.0.1:6767` 保留给打包应用和生产风格的 `~/.paseo` 状态。

### PASEO_HOME

`PASEO_HOME` 是存放运行时状态（agent、工作树、工作区配置、socket、守护进程日志）的目录。解析规则：

- **服务器自身**（例如由桌面应用启动或 `npm run start` 启动）默认使用 `~/.paseo`（参见 `packages/server/src/server/paseo-home.ts`）。
- **仓库开发脚本**默认使用 `$ROOT/.dev/paseo-home`，其中 `$ROOT` 是当前检出（checkout）或工作树根目录。这使所有开发状态限定在当前检出，而不是打包的桌面应用。
- **`npm run cli -- ...`** 通过相同的 dev-home 包装器运行，因此仓库内的 CLI 会自动使用当前检出的 `.dev/paseo-home` 和配置的开发守护进程端点。
- **Paseo 创建的工作树**会从 `$PASEO_SOURCE_CHECKOUT_PATH/.dev/paseo-home` 复制持久化的 JSON 元数据来初始化 `$PASEO_WORKTREE_PATH/.dev/paseo-home`。运行时文件（如 pid 文件、socket 和日志）不会被复制。
- **本仓库的工作树设置**还会尽力从源检出复制 `packages/app/ios` 和最新的 `.dev/ios-build` 条目，以便 iOS 模拟器服务在安全可行的情况下重用原生项目和 Xcode 缓存状态。

覆盖选项：

```bash
PASEO_HOME=~/.paseo-blue npm run dev          # 显式指定 home
PASEO_DEV_SEED_HOME=/path/to/home npm run dev # 从不同的源 home 初始化
PASEO_DEV_RESET_HOME=1 npm run dev            # 清除并重新初始化派生的工作树 home
```

### 守护进程端点

- 桌面应用启动的稳定守护进程：`localhost:6767`。
- 根目录检出开发守护进程：`localhost:6768`。
- 根目录检出 Expo：`http://localhost:8081`。
- 根目录检出桌面开发 Expo：从 `8082` 到 `8089` 的第一个空闲端口。
- `npm run dev`（Windows）：守护进程使用 `localhost:6767`。

在 Paseo 管理的工作树服务中，使用注入的服务环境变量，而不要硬编码根检出端口。

### Expo Router

路由所有权、启动恢复和原生白屏陷阱请参阅
[expo-router.md](expo-router.md)。在修改 `packages/app/src/app`、
启动路由、记住的工作区恢复或活动工作区选择之前，请先阅读该文档。

### iOS 模拟器预览服务

Paseo 工作树通过 `paseo.json` 中的 `ios-simulator` 服务暴露原生 iOS 开发应用。服务 URL 在 `/.sim` 提供模拟器预览，因此预览链接为 `${PASEO_URL}/.sim`。

该服务专为并发工作树设计：它从工作树路径推导出确定性的模拟器标识，使用分配给该工作树的 `PASEO_PORT`，将 `serve-sim` 固定到该模拟器 UDID，并且仅拆除该工作树的辅助/模拟器状态。它不能依赖全局启动的模拟器或任何固定的 Metro 端口。

工作树设置在服务运行前会尽力从源检出复制生成的 iOS 项目和最新的原生构建缓存。服务仍会通过运行 Expo prebuild 和 Xcode 来验证原生项目；复制只是为了避免每次从冷工作树重新构建。

启动服务不得创建、聚焦、显示或留下 macOS Simulator.app 窗口。浏览器预览是用户可见的模拟器界面。

### 桌面渲染器性能分析

`npm run dev:desktop` 启动 Electron 时会在
`http://127.0.0.1:9223` 上启用 Chromium 远程调试，以便通过 CDP 捕获渲染器 CPU 性能分析数据。
它会启动自己的 Electron 风格 Expo 服务器并将该 URL 传递给 Electron。
当 `9223` 端口被占用时，可通过 `PASEO_ELECTRON_REMOTE_DEBUGGING_PORT` 覆盖 CDP 端口。

当运行专用 Electron QA 实例使用非默认 Expo 端口时，请显式设置
`EXPO_DEV_URL`。桌面主进程默认使用 `http://localhost:8081`，因此
仅设置 `PASEO_PORT=57928` 会让 Metro 在 57928 上启动，但 Electron 仍然加载 8081。

### React 渲染性能分析

应用中有一个受控的 React 渲染分析器，位于
`packages/app/src/utils/render-profiler.tsx`。用 `RenderProfile` 包裹你要测量的
组件边界，然后用 `?renderProfile=1` 打开应用。当查询参数不存在时，
`RenderProfile` 直接返回子组件，不记录任何数据。

捕获的样本暴露在 `globalThis.__PASEO_RENDER_PROFILE__` 上。在预热之后、要测量的
交互之前，调用
`globalThis.__PASEO_RENDER_PROFILE_RESET__?.()`。如果某个 memo 比较器或订阅边界
需要解释，在分析时调用 `recordRenderProfileReasons(id, reasons)`；
原因计数暴露在 `globalThis.__PASEO_RENDER_PROFILE_REASONS__` 上。

对任何渲染问题调查，请使用以下工作流程：

1. 在可疑的根组件和昂贵的子组件周围添加稳定的 `RenderProfile` 边界。
   保持 ID 足够具体，以便前后对比。
2. 尽可能在真实应用状态下复现，而非使用玩具级测试数据。
3. 首先记录空闲基线。如果空闲状态下就有噪声，先修复或解决这个问题，
   再优化交互。
4. 预热路由，重置分析器样本，执行精确的交互，然后
   对比 `actualDuration`、渲染次数和每次提交的样本。
5. 当 memo 边界仍然发生渲染时，在修改代码前先记录原因。不要
   仅凭对象引用推断。
6. 保留那些真正改善分析结果的变更。移除那些没有改善指标的探针或 memo 包装器。

在工作区标签页调查中，此分析器发现了以下问题：

- 看似巨大的工作区开销实际上是真实的交互工作，而非守护进程噪声；
  空闲基线保持在接近零的水平。
- 昂贵的流重新渲染主要来自面板上下文回调和 capability 对象的 prop 引用变动，
  而非新的流数据。
- 在面板边界处稳定 provider actions 有帮助，因为每个已挂载的面板
  都消费该上下文。
- 比较值形式的 capability 标志优于通过无关 store 保持对象引用。
- 一些看似合理的修复方案并未奏效：对标签行和编辑器草稿对象进行 memo
  几乎没有改善分析结果，因此被移除。

现有场景脚本：工作区 agent/终端标签切换。在 web 上启动 Expo，
保持守护进程可用，然后运行：

```bash
PASEO_PROFILE_SERVER_ID=<server-id> \
PASEO_PROFILE_WORKSPACE_ID=<workspace-path> \
PASEO_PROFILE_AGENT_ID=<agent-id> \
  npm run profile:workspace-tabs --workspace=@getpaseo/app
```

此脚本用 `?renderProfile=1` 打开应用，创建一个临时终端标签页，
在真实 agent 和终端之间切换，打印聚合的 React Profiler 耗时数据，
然后移除临时终端。这是上述工作流程的一个示例，而非使用分析器的唯一方式。有用参数：

```bash
PASEO_PROFILE_APP_URL=http://localhost:19010 # Expo web URL
PASEO_PROFILE_SWITCH_COUNT=1                # agent/终端切换对的次数
PASEO_PROFILE_SWITCH_WAIT_MS=250            # 每次点击后的延迟
PASEO_PROFILE_IDLE_WAIT_MS=3000             # 切换前的空闲基线
PASEO_PROFILE_DUMP_COMMITS=1                # 包含每次提交的分析器样本
```

### 桌面 macOS 合成器看门狗

macOS 显示器休眠可能使 Chromium GPU 进程的显示链接（即垂直同步（vsync）
源，驱动帧生成）卡在过期的显示器上。合成器随后停止生成帧，
窗口看起来冻结：无法响应点击和按键，即使渲染器和所有进程仍然存活。它会在几分钟后
自行恢复，但对于前台应用来说这个时间太长了。

`setupDarwinCompositorWatchdog`
（`packages/desktop/src/window/compositor-watchdog/index.ts`）用于防范
此问题。它每隔几秒轮询渲染器的帧生成情况，
在窗口可见且未锁定期间持续停滞一段时间后，重启 GPU 进程，
以便 Chromium 重新建立显示链接。当屏幕锁定或窗口隐藏/最小化时，探针会被跳过，
因为这些情况下窗口停止生成帧是正常的。

看门狗有意**保持**后台节流启用。调用
`webContents.setBackgroundThrottling(false)` 会使合成器不停地产出帧，
让 ProMotion 显示器永远保持在 120Hz，在应用空闲时耗尽电池——
因此不要重新添加此调用。探针的可见性守卫已经防止了节流导致误报停滞。

### 守护进程日志

查看 `$PASEO_HOME/daemon.log` 获取守护进程日志。默认级别为 `info`；当需要完整的 provider、
会话和 agent-manager 追踪信息来调试卡住状态时，在启动守护进程前设置
`PASEO_LOG_LEVEL=trace`。

管理进程会对 `daemon.log` 进行轮转。`$PASEO_HOME/config.json` 中持久化的
`log.file.rotate` 设置具有最高优先级。没有持久化配置时，可选的
`PASEO_LOG_ROTATE_SIZE` 和 `PASEO_LOG_ROTATE_COUNT` 环境变量会覆盖
默认值。默认轮转设置为 `10m` x `3` 个文件，适用于所有环境。

## paseo.json 服务脚本

`worktree.setup` 和 `worktree.teardown` 接受多行 shell 脚本或命令数组。
两者都按顺序执行。

```json
{
  "worktree": {
    "setup": "npm ci\ncp \"$PASEO_SOURCE_CHECKOUT_PATH/.env\" .env\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

每个 `"type": "service"` 的 `scripts` 条目都会收到以下环境变量：

| 变量                         | 值                                                                                                                           |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `PASEO_SERVICE_<NAME>_URL`   | 已声明的同级服务的代理 URL。推荐用于服务发现；它能应对同级服务重启。                                                         |
| `PASEO_SERVICE_<NAME>_PORT`  | 已声明的同级服务的原始临时端口。仅作为绕过备用逃生通道使用；如果同级服务重启，该端口可能过期。                               |
| `PASEO_URL`                  | 自身别名，等同于 `PASEO_SERVICE_<SELF>_URL`。                                                                              |
| `PASEO_PORT`                 | 自身别名，等同于 `PASEO_SERVICE_<SELF>_PORT`。                                                                             |
| `HOST`                       | 服务进程的绑定主机地址。                                                                                                     |

服务代理主机名使用双连字符形状：`web--feature-auth--project.localhost`，或在默认分支上使用 `web--project.localhost`。可选的公共别名在配置的公共基础主机名下使用相同的左侧标签。

`<NAME>` 通过将脚本名大写、将所有非 `A-Z0-9` 字符替换为 `_`、并裁剪首尾的 `_` 来规范化。例如，`app-server` 和 `app.server` 都规范化为 `APP_SERVER`；该冲突会在启动时以可操作的错误信息提示失败。

默认不注入 `PORT`。如果某个框架需要 `PORT`，请在命令中设置：

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "PORT=$PASEO_PORT npm run dev:web"
    }
  }
}
```

## 捆绑的守护进程 Web UI

> 此功能的用户导向指南（启用方式、反向代理、TLS、隧道、安全）位于 [public-docs/web-ui.md](../public-docs/web-ui.md)。本节是贡献者/构建参考：说明构件如何生成、打包以及如何从桌面打包中排除。

守护进程可以选择从同一 HTTP 服务器提供浏览器 web 客户端。此功能默认禁用。

通过以下方式为运行中的守护进程启用：

```bash
paseo daemon start --web-ui
```

或设置环境变量：

```bash
PASEO_WEB_UI_ENABLED=true paseo daemon start
```

或在 `config.json` 中持久化：

```json
{
  "features": {
    "webUi": {
      "enabled": true
    }
  }
}
```

启用后，打开守护进程的 HTTP 源（例如 `http://localhost:6767/`）即可提供 web 应用。同一 HTTP 服务器继续提供 `/api/*`、`/mcp/*`、`/public/*`、WebSocket 升级以及服务代理路由。静态文件加载无需守护进程 bearer 认证；API 和 WebSocket 调用仍然强制认证。

提供的应用会自动启动连接到同一源，因此直接打开 `http://localhost:6767/` 通常可以跳过添加主机的步骤。

构建用于打包或测量的构件：

```bash
npm run build:daemon-web-ui
```

这会导出普通的浏览器 web 应用（非 Electron 风格的桌面渲染器）并将其复制到 `packages/server/dist/server/web-ui`，同时将 `.html`、`.js`、`.css` 和 JSON 资源预压缩为 `.br` 和 `.gz`。

标准 Expo web 导出的实测打包大小：

- raw: 10.77 MiB
- gzip: 2.55 MiB
- brotli: 1.93 MiB

桌面管理的守护进程默认禁用捆绑的 web UI（`PASEO_WEB_UI_ENABLED=false`），因为桌面应用已经将渲染器作为 `app-dist` 打包。在 `@getpaseo/server` 中再次打包相同的资源会导致约 10.8 MiB 的重复安装。桌面打包也会从打包应用中排除 `node_modules/@getpaseo/server/dist/server/web-ui/**`。

## 构建的工作区包

包导入通过包的导出解析到编译后的 `dist/` 输出，而非同级的 `src/` 文件。这在本地开发和已发布的包中都是如此：应用、守护进程、CLI 和 SDK 使用者都应该执行相同的运行时路径。

`npm run dev:server` 构建一次服务器端的工作区包，然后在守护进程运行期间通过 TypeScript watch 构建保持 `@getpaseo/protocol` 和 `@getpaseo/client` 同步。如果你在该 watch 工作流之外修改了协议 schema 或客户端代码，请在信任运行时行为之前重新构建生产者。

使用命名的根构建目标，而不必记忆工作区依赖链：

```bash
npm run build:client       # protocol -> client
npm run build:server-deps  # highlight -> relay -> protocol -> client
npm run build:server       # server-deps -> server -> cli
npm run build:app-deps     # highlight -> protocol -> client -> expo-two-way-audio
```

每当你修改了任何守护进程/服务器端包并需要干净的跨包类型或运行时行为时，请使用 `npm run build:server`。

对于更紧凑的循环，可以重新构建单个工作区：

- 修改了 `packages/protocol/src/*` 或 `packages/client/src/*`：`npm run build:client`。
- 修改了 `packages/server/src/*`、`packages/cli/src/*`、`packages/relay/src/*` 或 `packages/highlight/src/*`：`npm run build:server`。
- 修改了应用构建依赖：`npm run build:app-deps`。

## ACP provider 目录版本

应用内的 ACP provider 目录将 package-runner 条目（`npx`、`npm exec`
和 `uvx`）固定到精确的包版本。定期运行版本漂移检查器——在发布前
也要运行——以确保目录安装不会使用过期的 agent 版本：

```bash
npm run acp:version-drift        # 报告过期/非精确的包固定版本
npm run acp:version-drift:check  # 同上，有漂移时以非零退出码退出
npm run acp:version-drift:update # 将目录固定版本重写为最新精确版本
```

检查器只更新 package-runner 目录条目。使用预安装二进制文件的 provider，如 `opencode acp`、`cursor-agent acp` 或 `goose acp`，
被报告为跳过，因为它们的版本由用户本地安装决定。

## CLI 参考

使用 `npm run cli` 从源码运行仓库内的 CLI（`npx tsx packages/cli/src/index.ts`）。该脚本通过 `scripts/dev-home.sh` 包装 CLI，因此它会自动使用当前检出的 `.dev/paseo-home` 和开发守护进程端点，除非你传入显式的覆盖参数。macOS 上全局安装的 `paseo` 二进制文件是一个指向已安装 Paseo 桌面应用的符号链接，而非当前检出——用它来驱动桌面内置的守护进程，但当你想与你正在编辑的 CLI 通信时请使用 `npm run cli`。

```bash
npm run cli -- ls -a -g              # 全局列出所有 agent
npm run cli -- ls -a -g --json       # 同上，以 JSON 格式输出
npm run cli -- inspect <id>          # 显示 agent 详细信息
npm run cli -- logs <id>             # 查看 agent 时间线
npm run cli -- daemon status         # 检查守护进程状态
```

使用 `--host <host:port>` 将 CLI 指向不同的守护进程：

```bash
npm run cli -- --host localhost:7777 ls -a
```

## Agent 状态

Agent 数据位于：

```
$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json
```

按 ID 查找 agent：

```bash
find $PASEO_HOME/agents -name "{agent-id}.json"
```

按内容查找：

```bash
rg -l "some title text" $PASEO_HOME/agents/
```

## Provider 会话文件

从 agent JSON 获取会话 ID（`persistence.sessionId`），然后：

**Claude:**

```
~/.claude/projects/{cwd-with-dashes}/{session-id}.jsonl
```

**Codex:**

```
~/.codex/sessions/{YYYY}/{MM}/{DD}/rollout-{timestamp}-{session-id}.jsonl
```

## 使用 Playwright MCP 测试

将 Playwright MCP 指向正在运行的 Expo web 目标。对于根检出开发，`npm run dev:app` 预留 `http://localhost:8081`。对于 Paseo 管理的工作树应用服务，使用 Paseo 为该工作树显示的服务 URL 或端口。

不要使用浏览器历史记录（前进/后退）。始终通过点击 UI 元素或使用带完整 URL 的 `browser_navigate` 来导航——应用使用客户端路由，浏览器历史记录会破坏状态。

## 应用 Web 部署

`packages/app` 导出一个单页 Expo web 应用，并使用 `npm run deploy:web --workspace=@getpaseo/app` 将 `dist/` 目录部署到 Cloudflare Pages。

PWA 安装元数据位于 `packages/app/public/manifest.json`，并从
`packages/app/public/index.html` 链接。将安装图标保留在 `public/` 中，
以便 Cloudflare 在 `expo export` 后从稳定的根 URL 提供它们。

不要随意添加 service worker 缓存。Paseo 是 agent 的实时控制界面，
激进的服务 worker 缓存可能使已安装用户停留在过期的 web 代码上。如果离线行为成为产品需求，请有意识地添加，
并包含更新策略，同时测试已安装应用的升级路径。

## Expo 故障排除

```bash
npx expo-doctor
```

诊断版本不匹配和原生模块问题。

## 类型检查

每次修改后务必运行类型检查：

```bash
npm run typecheck
```
