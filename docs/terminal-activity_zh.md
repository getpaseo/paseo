# 终端活动指示器

Paseo 将终端活动显示为标签页指示器（与 agent 使用的相同"运行中"圆点）。

## 当前状态

终端活动是与来源无关的管道。`TerminalActivityTracker` 持有当前的每终端状态，并将转换发送到管理器、worker 协议、websocket 订阅、应用桶、圆点和通知。

跟踪器默认为未知（`null`）。活动产生位于终端流解析之外：agent hook 命令将粗略的活动报告给 daemon 的本地 `/api/terminal-activity` 端点。

## 架构

```
TerminalSession
  ├── TerminalActivityTracker               每个会话一个
  │     ├── set(state)                      记录最新状态
  │     └── onChange(snapshot, previous)    仅在已解析状态转换时触发
  │
  └── onActivityChange({ activity, previous })   在 TerminalManager 中订阅
        ├── emits terminalsChanged          仅终端列表/标签页指示器
        └── subscribeTerminalActivity       用于通知策略的每转换流
        └── subscribeTerminalWorkspaceContributionChanged  仅工作区状态汇总
```

`TerminalActivityTracker` 是每个会话的单一有状态对象。它持有 `{ state, changedAt }`，从未知（`null`）开始，并且仅在状态实际改变时触发 `onChange`。

终端目录快照（`terminalsChanged`）和工作区贡献更改是独立的关注点。仅标题更改产生终端列表快照，但从不触及工作区描述符。改变派生的工作区桶的转换（例如 idle -> working，working -> idle，注意力清除）既发出终端列表快照，又发出服务器内部的 `TerminalWorkspaceContributionChanged` 事件，Session 消耗该事件以使共享所属工作区 `cwd` 的每个活动工作区失效。

### 转换携带自己的历史

每个 `onChange` 传递新快照和 `previous` 快照（`{ state, changedAt }`）。转换不变地向上流经 `TerminalSession.onActivityChange`（作为 `{ activity, previous }`）、worker 协议的 `terminalActivityChange` 事件以及管理器级别的 `subscribeTerminalActivity(listener)` 流（`{ terminalId, name, cwd, activity, previous }`）。

Daemon 消费这些转换，而不是快照。当转换从 `working` 移到 `idle` 时，跟踪器记录已完成的注意力，因此终端显示与需要审查的空闲 agent 相同的绿色完成圆点。websocket 层还触发"终端已完成"注意力通知。在仍在工作时退出的终端不发出轮次结束通知。

终端列表可见性以 `workspaceId` 为范围：终端属于创建它的工作区，同 `cwd` 的兄弟工作区在其终端列表中看不到它。终端状态路由从该所属工作区开始，使用所属工作区的 `cwd`，然后将状态桶分发到每个具有相同 `cwd` 的活动工作区。

路径前缀路由仅是无主终端活动贡献的旧版回退。如果活动终端没有 `workspaceId`，daemon 从终端 `cwd` 解析最深的活动父工作区，然后将状态分发到该所有者的活动同 `cwd` 兄弟工作区。该回退贡献状态，但它不会使终端在工作区范围内的终端列表中可见。

## Hook 报告

当 daemon 创建 shell 时，终端接收四个环境变量：

- `PASEO_TERMINAL_ID`
- `PASEO_ACTIVITY_TOKEN`
- `PASEO_TERMINAL_ACTIVITY_URL`
- `PASEO_HOOK_CLI` —— 当前 `paseo` CLI 可执行文件的绝对路径。

生成的 shell 命令使用 `PASEO_HOOK_CLI` 来运行当前 CLI。`paseo hooks <agent> <event>` 然后读取终端 ID、令牌和活动 URL，要求 agent hook provider 注册表将事件解析为粗略的活动状态，并静默地将 `{ terminalId, token, state }` POST 到活动 URL。缺失环境变量、不支持的 agent/事件、格式错误的 hook 输入以及 daemon/网络故障都是空操作，因此 agent hook 永远不会破坏用户的终端会话。

Claude hook 映射：

- `UserPromptSubmit` → `running`
- `Stop`、`StopFailure`、`SessionEnd` → `idle`
- `Notification` 带有 `reason` 或 `matcher` 等于 `idle_prompt` → `needs-input`

Codex hook 映射：

- `UserPromptSubmit` → `running`
- `PreToolUse`、`PostToolUse` → `running`
- `PermissionRequest` → `needs-input`
- `Stop` → `idle`

OpenCode 使用服务器插件而不是命令 hook。插件监听 OpenCode 总线事件并发出这些 Paseo hook 事件：

- `session.status` 带有 `busy` 或 `retry` → `running`
- `session.status` 带有 `idle` → `idle`
- `permission.asked` → `needs-input`
- `permission.replied` → `running`

Daemon 将 hook 状态映射到终端活动，就像 agent 生命周期加上未读注意力：`running` → `state: working`，`idle` → `state: idle`，`needs-input` → `state: idle` 带有 `attentionReason: needs_input`。`working` → `idle` 转换记录 `state: idle` 带有 `attentionReason: finished`，直到用户聚焦该终端；普通空闲终端仍然不贡献工作区状态。

## 焦点清除

客户端心跳包含聚焦的终端 ID。当可见客户端聚焦一个带有 `attentionReason` 的终端时，daemon 清除注意力并使终端保持空闲。普通空闲终端活动不贡献工作区状态，因此唯一注意力来源是该终端的工作区从 `needs_input` 或 `attention` 回滚到 `done`。

### Agent hook 安装

安装 hook 会编辑用户的真实 agent 配置文件，因此它是选择加入的。Daemon 设置 `enableTerminalAgentHooks`（持久化在 `daemon.enableTerminalAgentHooks` 下，默认 `false`）控制安装。它在应用的宿主**终端**设置中显示为"启用终端 agent hook"——"从终端 agent 获取通知和状态。这会在你的 agent 配置文件中安装 hook。" `applyTerminalAgentHookSetting` 将已安装的 hook 与设置进行协调：启动时仅在启用时安装；动态切换设置时，启用时安装，禁用时移除 Paseo 标记匹配的 hook。`paseo hooks` 无论如何保持正常工作——门控只控制 daemon 是否将 hook 写入 agent 配置，而不是 CLI 在环境变量存在时是否可以发布活动。

启用后，Paseo 全局安装 provider hook：

- Claude hook 写入 `~/.claude/settings.json`（或当设置了该覆盖时的 `CLAUDE_CONFIG_DIR/settings.json`）。
- Codex hook 写入 `~/.codex/hooks.json`（或当设置了该覆盖时的 `CODEX_HOME/hooks.json`）。Codex 支持原生的 `commandWindows`，因此每个 Paseo hook 包含 POSIX 和 Windows 命令。非托管的 Codex hook 由 Codex 进行信任门控；用户可能在 hook 运行前看到 Codex 的 hook 审查提示。
- OpenCode 获得一个自包含插件，位于 `$XDG_CONFIG_HOME/opencode/plugins/paseo-terminal-activity.js`（或当 XDG 未设置时的 `~/.config/opencode/plugins/paseo-terminal-activity.js`；`OPENCODE_CONFIG_DIR` 在设置时仍然优先）。

安装对于配置 hook 是基于标记/幂等的，对于 OpenCode 插件是精确文件/幂等的。Paseo 保留用户 hook，仅移除自己标记匹配的命令 hook，并在 daemon 关闭后保持 hook 已安装。在 Paseo 终端之外，它们是惰性的，因为命令或插件受 `PASEO_TERMINAL_ID` 门控。

Provider 变体驻留在 `AGENT_HOOK_PROVIDERS` 中：provider ID、已安装的事件、配置安装元数据以及运行时事件到活动的解析。Daemon 调用一次 `installRegisteredAgentHooks()`；CLI 调用 `resolveHookActivity(provider, event, input)`。添加 provider 应添加一个 provider 条目并在 `AGENT_HOOK_PROVIDERS` 中注册它，而不编辑通用 CLI 命令或 daemon 引导。

已安装的 hook 命令保持配置可移植，并在运行时解析 CLI：

```sh
[ -n "$PASEO_TERMINAL_ID" ] && "${PASEO_HOOK_CLI:-paseo}" hooks claude <event>
```

Codex 也会收到 Windows 等效命令：

```bat
if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" hooks codex <event>) else (paseo hooks codex <event>))
```

Paseo 注入 `PASEO_HOOK_CLI`，因此 Codex 的 hook shell 不会在当前 CLI 之前获取到过时的全局 `paseo`。如果环境变量缺失，命令仍然回退到裸 `paseo`，并且在 Paseo 终端之外仍然是空操作，因为 `PASEO_TERMINAL_ID` 门控仍然是第一位的。Paseo 还将 CLI 二进制目录添加到每个终端的 `PATH` 前面作为辅助回退。所有其他行为驻留在 `paseo hooks` 中：读取环境变量，映射事件，POST 活动，并在任何内容缺失或不可用时空操作/故障开放。

如果配置安装失败，daemon 启动和终端生成将继续进行，只是没有终端活动 hook。
