# Paseo 术语表

权威术语。以 UI 标签为准。不要自创同义词；使用这里定义的术语。

- **Project（项目）** —— 共享一个 git remote（或主仓库根）的工作区的逻辑分组。UI："Project" / "Add project"。代码：`ProjectSummary`（`packages/app/src/utils/projects.ts:22`）、`projectKey`（`packages/server/src/server/workspace-registry-model.ts:16`）。禁止："Repo"、"Repository" 作为 UI 标签。
- **Workspace（工作区）** —— 一个守护进程上的一个具体的 `cwd`，具有 git 状态；恰好属于一个项目。其 `id` 是不透明的工作区标识；其 `cwd` 是文件系统目录。UI："Workspace"。代码：`WorkspaceDescriptorPayload`（`packages/protocol/src/messages.ts:2178`）。不要与以下混淆：Branch（一个分支可以通过工作树支持多个工作区）。禁止："Folder"、"Directory" 作为 UI 标签。
- **Workspace kind（工作区类型）** —— `"directory" | "local_checkout" | "worktree"`。工作区的 git 派生的、持久化的属性，在其整个生命周期中使用（归档安全、侧边栏、分组）。从 cwd 的 git 实际情况派生（`deriveWorkspaceKind`，`packages/server/src/server/workspace-registry-model.ts:158`），而非从用户选择存储。代码：`PersistedWorkspaceKind`（`packages/server/src/server/workspace-registry-model.ts:8`）。不要与 **Isolation（隔离方式）**（创建时的意图）混淆。
- **Isolation（隔离方式）** —— 新建工作区时的创建时选择：重用现有 checkout（**Local**）或创建专用的 git worktree（**New worktree**）。一个瞬态的设置输入，也会被记住为创建表单偏好；它不是工作区属性。UI：新建工作区屏幕上的 "Isolation" 控件。代码：`isolation`（`"local" | "worktree"`）、`useWorkspaceIsolation`（`packages/app/src/screens/new-workspace-screen.tsx`）；持久化为 `FormPreferences.isolation`（`packages/app/src/create-agent-preferences/preferences.ts`）。区别于 **Workspace kind**，后者是意图产生的 git 派生属性（Local → `local_checkout` 或 `directory`（取决于是否为 git 仓库）；New worktree → `worktree`）。在线路上它是创建请求的 `source.kind`（`directory | worktree`，`packages/protocol/src/messages.ts:1693`）。
- **Agent（代理）** —— 参见 **Agent session（代理会话）**。UI 中某些地方仍显示 "Agent" / "New Agent"，但正趋向使用 **Agent session** 作为规范术语。代码：`AgentSnapshotPayload`（`packages/protocol/src/messages.ts:608`）。禁止："Task"、"Job"、"Run"。
- **Daemon（守护进程）** —— 本地 Paseo 服务器进程；由 `serverId` 标识。UI："Daemon"（仅系统上下文中）。代码：`ServerInfoStatusPayloadSchema` 中的 `serverId`（`packages/protocol/src/messages.ts:1936`）、`DaemonClient`（`packages/client/src/daemon-client.ts`）。
- **Host（主机）** —— 客户端侧的连接配置，指向一个守护进程；捆绑一个或多个 `HostConnection`。UI："Host" / "Add host" / "Switch host"。代码：`HostProfile`（`packages/app/src/types/host-connection.ts:37`）。禁止："Connection"（指 `HostConnection`，而非 host）。
- **Project host entry（项目主机条目）** —— 项目中单个（项目, 守护进程）对的一行，聚合该守护进程在该项目中的工作区。内部使用。代码：`ProjectHostEntry`（`packages/app/src/utils/projects.ts:11`）。不要引入 "Checkout" 作为同义词。
- **Placement（放置信息）** —— 一个工作区与其项目的关系（projectKey、projectName、git checkout 快照）。内部使用。代码：`ProjectPlacementPayload`（`packages/protocol/src/messages.ts:2113`）。
- **Branch（分支）** —— 普通的 git 分支。UI："Switch branch"。代码：`WorkspaceGitRuntimePayloadSchema` 中的 `currentBranch`（`packages/protocol/src/messages.ts:2136`）；`BranchSwitcher`（`packages/app/src/components/branch-switcher.tsx`）。
- **Worktree（工作树）** —— Paseo 管理的 git worktree（`~/.paseo/worktrees/{name}`）；也是一个 `workspaceKind` 值。UI：仅 CLI + `paseo.json` 键（`worktree.setup`、`worktree.teardown`）。代码：`ProjectCheckoutLiteGitPaseoPayload`（`packages/protocol/src/messages.ts:2092`）；CLI `paseo worktree`（`packages/cli/src/commands/worktree/index.ts:8`）。禁止："Checkout" 作为同义词。
- **Repository / Remote（仓库 / 远程）** —— 内部 git 输入（`remoteUrl`、`mainRepoRoot`），用于派生 `projectKey`。无 UI 标签。
- **Directory-backed surface（目录支持界面）** —— 一种右侧边栏界面，其内容由工作区的 `cwd` 决定，因此同一目录上的两个工作区看到相同的内容：git diff/status、GitHub PR 信息、文件预览/浏览器内容。以 `(serverId, cwd)` 为键，而非 `workspaceId`。参见 [architecture.md](architecture.md#right-sidebar-boundary-directory-backed-vs-workspace-owned)。
- **Workspace-owned state（工作区拥有状态）** —— 每个工作区独有的状态，不会泄漏到相同 `cwd` 的兄弟工作区：标签页、代理、终端、分栏、标题，以及审查草稿、diff 模式覆盖、编辑器附件和文件浏览器打开/展开状态。以 `workspaceId` 为键（`cwd` 仅作为旧载荷的回退）。参见 [architecture.md](architecture.md#right-sidebar-boundary-directory-backed-vs-workspace-owned)。
- **Workspace status bucket（工作区状态桶）** —— 工作区行的聚合活动信号。相同 `cwd` 的工作区有意共享代理和终端状态桶，而标签页、代理和终端可见性仍以 `workspaceId` 为作用域。
- **Agent session（代理会话）** —— 工作区内一个正在运行的代理实例（一个提供方、一个模型、一个 cwd、一条时间线）。概念单元；在 UI 中作为标签页打开。正趋向以此作为规范术语取代 "Agent"。代码：`AgentSnapshotPayload`（`packages/protocol/src/messages.ts:608`）。
- **Session（会话）** —— 两种含义：（a）每个客户端到守护进程的连接，内部使用；（b）面向用户的代理会话，参见 **Agent session**。代码：（a）为 `Session`（`packages/server/src/server/session.ts`）。不要与以下混淆：提供方侧的代理会话日志。
- **Profile（配置）** —— 主机持久化形态的内部名称。代码：`HostProfile`（`packages/app/src/types/host-connection.ts:37`）。从不对用户显示。
- **Provider（提供方）** —— 代理后端（Claude Code、Codex、Copilot、OpenCode、Pi、OMP）。UI："Provider"。代码：`ProviderSnapshotEntry`（`packages/protocol/src/messages.ts:198`）。
- **Model（模型）** —— 提供方提供的特定 LLM。UI："Model" / "Select model"。代码：`AgentModelDefinition`（`packages/protocol/src/messages.ts:187`）。
- **Tab（标签页）** —— 表示工作区内一个会话的 UI 界面。非概念单元；在谈论模型时使用 **Agent session**。代码：`WorkspaceTabDescriptor`（`packages/app/src/screens/workspace/workspace-tabs-types.ts`）。
- **Terminal（终端）** —— 工作区作用域的 PTY shell，通过二进制多路复用通道流式传输。UI："Terminal"。代码：`TerminalStreamFrame`（`packages/protocol/src/terminal-stream-protocol.ts`）。
- **Schedule（定时）** —— Cron 风格的触发器，创建新代理。UI：CLI/MCP（`paseo schedule`、`create_schedule`）。不要与以下混淆：Heartbeat（cron 提示发送回同一代理）或 Loop（一个代理的迭代重复执行）。
- **Heartbeat（心跳）** —— Cron 风格的提示发送回同一代理/对话。MCP：`create_heartbeat`。用于提醒和托管，状态应内联返回。
- **Mode（模式）** —— 提供方特定的操作模式（plan、default、full-access 等）。UI：仅图标。代码：`AgentSessionConfig` 中的 `modeId`（`packages/protocol/src/messages.ts:257`）。
- **Attachment（附件）** —— 绑定到代理提示的 GitHub PR 或 Issue。UI："Attach issue or PR"。代码：`AgentAttachment`（`packages/protocol/src/messages.ts:782`）。
- **Composer（编辑器）** —— 用于向代理发送工作的整个提示界面。代码：`Composer`（`packages/app/src/composer/index.tsx`）。不要称之为 "message input"，除非指文本输入子组件。
- **Composer input（编辑器输入区）** —— 编辑器内部的文本输入界面。代码：`MessageInput`（`packages/app/src/composer/input/input.tsx`）。
- **Composer toolbar（编辑器工具栏）** —— 编辑器输入区内部的底部控制行。包含代理控件、附件按钮、语音控件和停止/发送控件。代码：`MessageInput` 中的 `leftContent`、`beforeVoiceContent` 和 `rightContent` 插槽（`packages/app/src/composer/input/input.tsx`）。禁止："Status bar"。
- **Agent controls（代理控件）** —— 代理或草稿代理的提供方、模型、模式、思考和提供方功能控件。代码：`AgentControls` / `DraftAgentControls`（`packages/app/src/composer/agent-controls/index.tsx`）。禁止："Agent status bar"。
- **Composer footer（编辑器页脚）** —— 渲染在编辑器输入区下方但仍位于键盘偏移的编辑器布局内的可选区域。代码：`Composer.footer`（`packages/app/src/composer/index.tsx`）。
- **Composer track（编辑器轨道）** —— 编辑器输入区上方的上下文通道。具体轨道使用 `<thing> track` 形式：**Queue track**、**Subagents track**。代码：`Composer` 内部的 queue track（`packages/app/src/composer/index.tsx`）、`SubagentsTrack`（`packages/app/src/subagents/track.tsx`）。
- **Attachment tray（附件托盘）** —— 编辑器输入区内部、文本输入上方的已选附件行。代码：`renderAttachmentTray`（`packages/app/src/composer/index.tsx`）。禁止："Attachment bar"。
- **Conflict（冲突）** —— 两种不同的含义；在 UI 文案中不要裸用该词而不加限定：（a）`paseo.json` 上的**陈旧写入冲突**（"Config changed on disk"，代码 `stale_project_config`，`packages/app/src/screens/project-settings-screen.tsx:593`）；（b）**git 合并冲突**（当前无 UI 字符串）。

## 不一致之处（已记录，不掩盖）

- CLI `--host <host>` 描述 `"Daemon host target"`（`packages/cli/src/utils/command-options.ts:5`）模糊了 daemon/host 的界限；应用保持二者的区分。
- `WorkspaceDescriptorPayloadSchema.workspaceKind` 在线路上接受遗留的 `"checkout"`（`packages/protocol/src/messages.ts:2187`），而 `PersistedWorkspaceKind` 不接受（`packages/server/src/server/workspace-registry-model.ts:8`）。
