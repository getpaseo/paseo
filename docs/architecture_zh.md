# 架构

Paseo 是一个客户端-服务器系统，用于监控和控制本地 AI 编程 agent。守护进程在你的机器上运行，管理 agent 进程，并通过 WebSocket 实时流式传输其输出。客户端（移动应用、CLI、桌面应用）连接到守护进程以观察和与 agent 交互。

你的代码永远不会离开你的机器。Paseo 是本地优先的。

## 系统概览

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  移动应用     │    │    CLI      │    │  桌面应用     │
│   (Expo)     │    │ (Commander) │    │  (Electron)  │
└──────┬───────┘    └──────┬──────┘    └──────┬──────┘
       │                   │                  │
       │    WebSocket      │    WebSocket     │    受管理的子进程
       │    (直接或         │    (直接)        │    + WebSocket
       │     通过中继)      │                  │
       └───────────┬───────┴──────────────────┘
                   │
            ┌──────▼──────┐
            │   守护进程    │
            │  (Node.js)   │
            └──────┬──────┘
                   │
      ┌────────────┼────────────┬────────────┬────────────┐
      │            │            │            │            │
┌─────▼─────┐ ┌───▼────┐ ┌──────▼─────┐ ┌────▼─────┐ ┌────▼────┐
│  Claude   │ │ Codex  │ │  Copilot   │ │ OpenCode │ │   Pi    │
│  Agent    │ │ Agent  │ │   Agent    │ │  Agent   │ │ Agent   │
│  SDK      │ │ Server │ │    ACP     │ │          │ │         │
└───────────┘ └────────┘ └────────────┘ └──────────┘ └─────────┘
```

## 组件一览

- **守护进程（Daemon）：** 本地服务器，启动和管理 agent 进程并暴露 WebSocket API。
- **应用（App）：** 跨平台 Expo 客户端，支持 iOS、Android、web 以及桌面端共享 UI。
- **CLI：** 用于 agent 工作流的终端界面，也可以启动和管理守护进程。
- **桌面应用（Desktop app）：** Electron 封装的 web 应用，捆绑并自动管理自己的守护进程。
- **中继（Relay）：** 可选的加密桥接，用于远程访问而无需直接开放端口。

## 包

### `packages/server` —— 守护进程

Paseo 的核心。一个 Node.js 进程，功能包括：

- 监听来自客户端的 WebSocket 连接
- 管理 agent 生命周期（创建、运行、停止、恢复、归档）
- 通过时间线模型实时流式传输 agent 输出
- 通过传输无关的工具目录提供 agent 到 agent 的工具，MCP 是其中的一个适配器
- 可选地出站连接到中继以实现远程访问
- 可选地从同一 HTTP 服务器提供浏览器 web 客户端（自托管指南：[public-docs/web-ui.md](../public-docs/web-ui.md)）

所有路径位于 `packages/server/src/` 下。

**关键模块：**

| 模块                             | 职责                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `server/bootstrap.ts`            | 守护进程初始化：HTTP 服务器、WS 服务器、agent 管理器、存储、中继 |
| `server/websocket-server.ts`     | WebSocket 连接管理、hello 握手、二进制帧路由                  |
| `server/session.ts`              | 每个客户端的会话状态、时间线订阅、终端操作                     |
| `server/agent/agent-manager.ts`  | Agent 生命周期状态机、时间线追踪、订阅者管理                   |
| `server/agent/agent-storage.ts`  | 文件支持的 JSON 持久化，位于 `$PASEO_HOME/agents/`            |
| `server/agent/tools/`            | 传输无关的 Paseo 工具目录，用于子 agent、权限、工作树          |
| `server/agent/mcp-server.ts`     | 薄 MCP 适配器，将 Paseo 工具目录注册到 MCP SDK                |
| `server/agent/providers/`        | Provider 适配器（见下文"Agent providers"）                   |
| `server/relay-transport.ts`      | 带 E2E 加密的出站中继连接                                     |
| `server/schedule/`               | 基于 cron 的定时 agent                                        |
| `server/loop-service.ts`         | 循环运行的 agent，重试直到满足退出条件                        |
| `server/chat/`                   | 聊天室，用于 agent 之间以及人与 agent 之间的消息              |

### `packages/protocol` —— 线格式 schema 和共享协议类型

WebSocket 消息、二进制帧编解码器、端点解析、
agent 时间线类型、provider 配置 schema 以及其他守护进程
和客户端共享值的权威来源。Server、app、CLI 和 `@getpaseo/client` 都依赖此包；
它不依赖 server。

### `packages/client` —— 守护进程客户端库和 SDK 门面

拥有低级守护进程 WebSocket 驱动以及高级 `PaseoClient`
门面。App 和 CLI 可能在迁移期间从
`@getpaseo/client/internal/daemon-client` 导入低级驱动，而新的 SDK 风格
代码从 `@getpaseo/client` 导入。

### `packages/app` —— 移动 + web 客户端（Expo）

跨平台 React Native 应用，可连接到一个或多个守护进程。

- Expo Router 导航（`/h/[serverId]/workspace/[workspaceId]`，`/h/[serverId]/agent/[agentId]` 等）。`workspaceId` URL 段是一个不透明的工作区 ID（目前是路径形状，用于路由时进行不透明编码），不是直接可读的文件系统路径。
- `HostRuntimeController` 管理保存的主机连接、重连和每主机的运行时状态
- `SessionContext` 为活动会话包装守护进程客户端
- Composer UI 和提交/草稿行为位于 `packages/app/src/composer/` 中；屏幕和面板应从那里集成，而不是将编辑器内部实现放到 `components/`、`hooks/` 或 `screens/workspace/` 中
- 时间线 reducer 位于 `timeline/session-stream-reducers.ts`，处理压缩、间隙检测、基于序列号的去重
- 时间线同步正确性记录在 [docs/timeline-sync.md](timeline-sync.md) 中：实时流用于即时性，`fetch_agent_timeline_request` 是权威的，追赶过程是分页但完整的。
- 语音功能：听写（STT）和语音 agent（实时）

### `packages/cli` —— 命令行客户端

基于 Commander.js 的 CLI，提供 Docker 风格的命令。常见的 agent 操作也在顶层暴露（例如 `paseo ls`、`paseo run`）。

- `paseo agent ls/run/import/attach/logs/stop/delete/send/inspect/wait/archive/reload/update/mode`
- `paseo daemon start/stop/restart/status/pair/set-password`
- `paseo chat ls/create/inspect/post/read/wait/delete`
- `paseo terminal ls/create/capture/send-keys/kill`
- `paseo loop run/ls/inspect/logs/stop`
- `paseo schedule create/ls/inspect/update/pause/resume/run-once/logs/delete`
- `paseo permit allow/deny/ls`
- `paseo provider ls/models`
- `paseo worktree create/ls/archive`
- `paseo speech …`

通过与应用相同的 WebSocket 协议与守护进程通信。

### `packages/relay` —— E2E 加密中继

在守护进程位于防火墙后方时实现远程访问。

- Curve25519 ECDH 密钥交换 + XSalsa20-Poly1305（NaCl `box`）加密
- 中继服务器是零知识的——它路由加密字节，无法读取内容
- 客户端和守护进程通道具有相同的 API（`createClientChannel`，`createDaemonChannel`）
- 通过 QR 码配对将守护进程的公钥传输给客户端
- 自托管中继通过 `daemon.relay.useTls` 或 `PASEO_RELAY_USE_TLS=true` 选择加入 TLS；面向公众（客户端）的 TLS 设置可通过 `daemon.relay.publicUseTls` 或 `PASEO_RELAY_PUBLIC_USE_TLS` 独立覆盖

完整威胁模型见 [SECURITY.md](../SECURITY.md)。

### `packages/desktop` —— 桌面应用（Electron）

适用于 macOS、Linux 和 Windows 的 Electron 封装。

- 可以将守护进程作为受管理的子进程启动
- 原生文件访问用于工作区集成
- 与移动应用使用相同的 WebSocket 客户端

**多窗口（混合落点模型）。** `main.ts` 中的 `createWindow()` 是可复用的：`⌘⇧N`/文件→新建窗口、重新启动应用（`second-instance`）以及侧边栏中的"在新窗口中打开"操作，每一个都打开一个新的 `BrowserWindow`。每个窗口都显示完整的侧边栏——没有每个窗口的项目所有权或过滤。"登录到项目"通过每个 `webContents` 的 `PendingOpenProjectStore` 实现：每个窗口在挂载时拉取自己的待定项目路径（`paseo:get-pending-open-project`）并运行正常的打开项目流程，与 CLI `paseo <path>` 启动完全相同。

> **窗口状态 v1 限制：** 只有会话的_第一个_窗口会恢复和持久化保存的几何尺寸（大小/位置/最大化）。通过 ⌘⇧N / second-instance / "在新窗口中打开" 打开的窗口使用默认大小、OS 级联排列，且不持久化——这避免了每个窗口堆叠在相同的已保存边界上并争夺单一的窗口状态存储。解除此限制需要每个窗口独立的状态键。
>
> **应用内浏览器面板尚不支持每个窗口独立。** 浏览器 webview 由一个进程全局注册表跟踪，该注册表为每个浏览器 ID 保持单个当前 `WebContents`。人类焦点仍然记录工作区活动浏览器以用于 UI 状态和 `list_tabs` 报告，但 agent 自动化仅针对 `browser_new_tab` 或 `browser_list_tabs` 返回的显式浏览器 ID。webview 注册队列（`main.ts` 中的 `pendingBrowserWebviewIds`）仍然是进程全局的。当浏览器面板在两个窗口中打开时，菜单 Reload 可能针对另一个窗口的 webview，并且跨窗口几乎同时的 webview 附加可能在错误的浏览器 ID 下注册。多窗口 v1 交付了窗口；使浏览器-webview 子系统窗口作用域化是后续工作。

### `packages/website` —— 营销网站

TanStack Router + Cloudflare Workers。提供 paseo.sh。

## WebSocket 协议

所有客户端通过一个同时混合 JSON 文本帧和用于终端流的小型二进制帧的单一连接使用相同的 WebSocket 协议。Schema 位于 `packages/protocol/src/messages.ts`。

**握手：**

```
客户端 → 服务器:  WSHelloMessage {
                    type: "hello",
                    clientId,
                    clientType: "mobile" | "browser" | "cli" | "mcp",
                    protocolVersion,
                    appVersion?,
                    capabilities?: { voice?, pushNotifications?, ... },
                  }
服务器 → 客户端:  状态消息，payload 为 { status: "server_info",
                    serverId, hostname, version, capabilities?, features }
```

没有专用的欢迎消息；服务器在接受 hello 后发出 `status` 会话消息，然后开始流式传输。会话存储来自 hello 的客户端 capabilities 并在重连时恢复它们，因此线格式边界可以问一个问题：`session.supports(...)`。

**顶层 WS 信封** 包括 `hello`、`recording_state`、`ping`/`pong` 以及 `session`（包装了丰富的会话消息联合类型）。

客户端活跃度检查使用顶层 JSON `ping`/`pong` 信封，而非会话 RPC，也非 RFC6455 协议 ping。应用通过浏览器和 React Native WebSocket API 运行，这些 API 不暴露协议 ping，因此此信封是测试直接或中继数据路径的可移植方式。会话 RPC 超时是操作失败，不得被视为 socket 已死的证据。

客户端会话 RPC 等待默认 60 秒，以便慢速中继或移动网络不会将存活但延迟的守护进程响应误判为操作失败。将连接超时、应用级宽限期、显式诊断延迟探针、活跃度 ping 定时器以及真正长时间运行的 RPC 与此默认值区分开。

新的会话 RPC 使用带 `.request` 和 `.response` 后缀的点分名称，例如 `checkout.github.set_auto_merge.request` 和 `checkout.github.set_auto_merge.response`。约定和旧扁平 RPC 名称的迁移规则见 [rpc-namespacing.md](rpc-namespacing.md)。

**重要的会话消息类型：**

- `agent_update` —— Agent 状态变化（状态、标题、标签）
- `agent_stream` —— 运行中 agent 的新时间线事件
- `workspace_update`、`script_status_update`、`workspace_setup_progress` —— 工作区状态
- `agent_permission_request` / `agent_permission_resolved` —— 工具调用权限流程
- `agent_deleted`、`agent_archived`、`agent_status`、`agent_list`
- `checkout_status_update`、`checkout_diff_update` 以及完整的 `checkout_*` 请求/响应集用于 git 操作
- 终端订阅/输入/捕获命令
- 语音/听写流事件（`dictation_stream_*`、`assistant_chunk`、`audio_output`、`transcription_result`）
- 用于 fetch、list、create 等的请求/响应对，通过 `requestId` 关联；失败使用 `rpc_error`

**二进制帧（终端流协议）：**

终端 I/O 以二进制 WebSocket 帧发送，由 `shared/binary-frames/terminal.ts` 中的 `decodeTerminalStreamFrame` 解码。布局如下：

- 1 字节操作码：`Output (0x01)`、`Input (0x02)`、`Resize (0x03)`、`Snapshot (0x04)`
- 1 字节槽位：终端槽位 ID
- 可变 payload：输出/输入字节，resize 用 JSON 编码的 `{ rows, cols }`，快照用终端快照

终端 PTY 大小遵循最后交互客户端胜出原则。客户端仅在终端视口真正改变大小或用户聚焦/点击终端时才声称 PTY 大小。被动渲染工作——附加、恢复可见性、字体稳定、渲染器重新适配或仅仅查看可见终端——不得发送 resize 帧。服务器不广播 resize 所有权；调整大小后的 PTY 通过正常输出重新绘制，每个附加的客户端在其自己的本地视口中渲染该输出。

同一目录中还有单独的文件传输二进制帧格式，用于下载/上传流。

### 兼容性规则

- WebSocket schema 是仅追加的。添加字段，不删除字段，绝不要将可选字段变为必填。
- 新的线格式枚举值必须在序列化时用 `session.supports(CLIENT_CAPS.someCapability)` 进行门控。
- `Session` 存储来自 `hello` 握手的客户端 capabilities 并在重连时恢复，因此线格式边界可以问一个问题：`session.supports(...)`。

示例：添加新的枚举值

```ts
// 1. 添加 CLIENT_CAPS.newThing = "new_thing"
// 2. 让新客户端在 WS hello 中通告它
// 3. 保持共享生产者 schema 为 strict
// 4. 门控新发出的值：session.supports(CLIENT_CAPS.newThing) ? "new_value" : "old_value"
```

## Agent 生命周期

生命周期状态定义在 `shared/agent-lifecycle.ts` 中：

```
initializing → idle ⇄ running
        ↓       ↓        ↓
              error
                ↓
              closed
```

- `initializing` —— 正在创建 provider 会话
- `idle` —— 有活跃会话，等待下一次提示
- `running` —— provider 正在产生一个回复
- `error` —— 上次尝试失败；会话仍然附加
- `closed` —— 终止状态，无活跃会话

`ManagedAgent` 是基于这些生命周期标签的可辨识联合类型。注意事项：

- **AgentManager** 是 agent 状态的权威来源，并向所有订阅者广播更新
- 时间线是仅追加的，具有 epoch（每次运行开始一个新的 epoch）。存储使用序列号进行客户端去重；默认获取页面为 200 项
- 时间线行 `timestamp` 值是守护进程拥有的规范时间戳。Provider 可能提供原始回放时间戳，但客户端不得根据本地时钟启发式猜测时间戳可信度或隐藏时间 UI。
- 事件实时流式传输给已连接的客户端；正确性由权威时间线获取和完整分页追赶来保证。
- Agent 状态持久化到 `$PASEO_HOME/agents/{cwd-with-dashes}/{agent-id}.json`（时间线行与记录一起存储）。该存储路径从 `cwd` 派生，而非从工作区 ID。

## 右侧边栏边界：目录支持 vs 工作区拥有

两个工作区可以共享相同的 `cwd`（例如一个 `directory` 工作区和一个 `local_checkout` 工作区在同一文件夹上，或针对同一检出的多个工作区）。模型 B 保持它们区分：它们共享由目录决定的一切，但不共享工作区独有的任何内容。右侧边栏界面沿此线清晰分割，分割完全由**每段状态的键**来强制执行。

**目录支持的（由相同 `cwd` 的工作区共享）——键由 `(serverId, cwd)` 决定，绝不由 `workspaceId` 决定：**

| 界面                | 键                                                        | 来源                                                  |
| -------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Git 状态             | `checkoutStatusQueryKey(serverId, cwd)`                    | `packages/app/src/git/query-keys.ts`                    |
| Git diff             | `checkoutDiffQueryKey(serverId, cwd, mode, baseRef, ws)` | `packages/app/src/git/query-keys.ts`                    |
| GitHub PR 状态       | `checkoutPrStatusQueryKey(serverId, cwd)`                | `packages/app/src/git/query-keys.ts`                    |
| PR 面板时间线         | `prPaneTimelineQueryKey({ serverId, cwd, prNumber })`    | `packages/app/src/git/pull-request-panel/query-keys.ts` |
| 文件预览内容          | `["workspaceFile", serverId, cwd, path]`                 | `packages/app/src/components/file-pane.tsx`             |
| 文件浏览器列表        | 通过 `listDirectory(workspaceRoot, path)` 获取            | `packages/app/src/hooks/use-file-explorer-actions.ts`   |

**工作区拥有的（每个工作区独立）——键由 `workspaceId` 决定（仅当没有 `workspaceId` 时回退到 `cwd`）：**

| 状态                        | 键构建器 / store                                | 来源                                                        |
| ---------------------------- | -------------------------------------------------- | ------------------------------------------------------------- |
| Review 草稿评论              | `buildReviewDraftKey` / `buildReviewDraftScopeKey` | `packages/app/src/review/store.ts`                            |
| Diff 模式覆盖                | review-draft scope 键（内存中）                     | `packages/app/src/review/state.ts`                            |
| Composer 附件                | `buildWorkspaceAttachmentScopeKey`                 | `packages/app/src/attachments/workspace-attachments-store.ts` |
| 文件浏览器导航/打开状态       | `fileExplorer` map 键 `workspace:{workspaceId}`    | `packages/app/src/hooks/use-file-explorer-actions.ts`         |
| 文件浏览器展开路径            | `expandedPathsByWorkspace[workspaceStateKey]`      | `packages/app/src/stores/panel-store/state.ts`                |

`diff-pane.tsx` 是规范的连接点：它将 `{ serverId, cwd }` 传递给 git 查询，将 `{ serverId, workspaceId, cwd }` 传递给草稿/覆盖/附件的 scope 键。

**不要"修复"掉共享。** 用 `workspaceId` 给目录支持的查询重新设置键会使相同 `cwd` 的工作区产生分歧（同一 git 树的两个窗口显示不同的 diff）。用 `cwd` 给工作区拥有的状态（草稿、展开路径）重新设置键会使它们在同一文件夹上的不同工作区之间泄漏。`workspaceId` 键构建器带有一条 `// workspaceId is opaque; do not parse this key back into a path.` 注释——不透明 ID 回退到 `cwd` 仅用于没有 `workspaceId` 的旧 payload，而非作为内容共享机制。

一个有意义的不违规之处：`AgentFileExplorerState.directories`/`files` 在 `workspaceId` 键的浏览器 map 内缓存目录列表。因此相同 `cwd` 的工作区保持重复缓存，但它们绝不会产生分歧——两者都通过 `listDirectory(workspaceRoot, …)` 获取相同的目录。这是重复而非泄漏，按现状保留。

## Agent providers

每个 provider 实现 `agent/agent-sdk-types.ts` 中的 `AgentClient` 接口。Provider 实现位于 `agent/providers/` 中。

内置的面向用户的 provider 有 Claude Code、Codex、Copilot、OpenCode、Pi 和 OMP。同一目录中还有用于 ACP 兼容 agent 和内部用途的其他适配器：

| Provider            | 包装                                  | 会话格式                                             |
| ------------------- | ------------------------------------- | ---------------------------------------------------- |
| Claude (`claude/`)  | Anthropic Agent SDK                   | `~/.claude/projects/{cwd}/{session-id}.jsonl`      |
| Codex               | Codex AppServer (`codex-app-server`)  | `~/.codex/sessions/{date}/rollout-{ts}-{id}.jsonl` |
| Copilot             | GitHub Copilot（通过 ACP）            | Provider 管理                                        |
| OpenCode            | OpenCode server / CLI                 | Provider 管理                                        |
| Cursor              | ACP 包装器 (`acp-agent`)              | Provider 管理                                        |
| Generic ACP         | ACP 包装器                            | Provider 管理                                        |
| Pi                  | 本地 Pi RPC 进程                      | Provider 管理                                        |
| Mock load test      | 进程内假实现                          | 内存中                                                |

所有 providers：

- 自行处理认证（Paseo 不管理 API 密钥）
- 通过持久化句柄支持会话恢复
- 将工具调用映射到规范化的 `ToolCallDetail` 类型
- 暴露 provider 特定模式（plan、default、full-access）

可以接受原生工具定义的 Provider 应设置 `supportsNativePaseoTools` 并读取 `launchContext.paseoTools`。然后守护进程直接传递共享的 Paseo 工具目录，并从该 provider 的启动配置中移除内部 Paseo MCP 服务器。仅支持 MCP 的 Provider 继续通过 `/mcp/agents` 的 MCP 回调接收相同的工具。

## 数据流：运行 agent

1. 客户端发送 `CreateAgentRequestMessage` 及配置（prompt、cwd、provider、model、mode）
2. Session 路由到 `AgentManager.create()`
3. AgentManager 创建 `ManagedAgent`，初始化 provider 会话
4. Provider 运行 agent → 发出 `AgentStreamEvent` 条目
5. 事件追加到 agent 时间线，广播给所有已订阅的客户端
6. 工具调用规范化为 `ToolCallDetail`（shell、read、edit、write、search 等）
7. 权限请求流：agent → server → client → 用户决策 → server → agent

## 存储

`$PASEO_HOME` 默认为 `~/.paseo`。最重要的文件：

```
$PASEO_HOME/
├── agents/{cwd-with-dashes}/{agent-id}.json   # Agent 记录 + 持久化的时间线行
├── projects/projects.json                      # 项目注册表
├── projects/workspaces.json                    # 工作区注册表
├── chat/                                       # 聊天室
├── schedules/                                  # 定时 agent 定义和运行记录
├── loops/                                      # 循环运行记录和日志
├── config.json                                 # 守护进程配置（可变）
├── daemon-keypair.json                         # 守护进程标识（用于中继/E2EE）
├── push-tokens.json                            # 移动推送 token
├── paseo.sock / paseo.pid                      # 本地 IPC socket 和 pidfile
└── daemon.log                                  # 守护进程追踪日志（轮转）
```

## 部署模型

1. **本地守护进程**（默认）：`paseo daemon start` 在 `127.0.0.1:6767` 上运行
2. **受管理的桌面端**：Electron 应用以子进程方式启动守护进程
3. **远程 + 中继**：守护进程在防火墙后方，中继通过 E2E 加密桥接
