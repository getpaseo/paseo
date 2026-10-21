---
title: CLI 参考
description: "Paseo CLI 参考：在终端中管理项目、工作区、Agent、插件、脚本、定时任务、daemon 和权限。"
nav: CLI 参考
---

# CLI 参考 {#cli-reference}

Paseo CLI 让你在终端中管理 Agent。它与 daemon 的 API 提供的接口相同，因此能在应用中做的事，都可以在命令行中完成。

> **Agent 编排**：你可以让编程 Agent 使用 Paseo CLI 启动和管理其他 Agent。Paseo 会识别发起调用的 Agent，因此通过 CLI 创建的执行者与通过 MCP 创建的执行者获得相同的工作区和父级默认值。

## 速查 {#quick-reference}

```bash
paseo run "fix the tests"            # Start an agent
paseo ls                             # List running agents
paseo attach <id>                    # Stream agent output
paseo send <id> "also fix linting"   # Send follow-up task
paseo logs <id>                      # View agent timeline
paseo stop <id>                      # Stop an agent
paseo usage                          # Show account quotas and balances
```

## 账号用量 {#account-usage}

显示主机用量来源中的账号配额和余额：

```bash
paseo usage
paseo usage ls --refresh
paseo usage ls --agent <agent-id>
paseo usage inspect <report-id>
paseo usage inspect <report-id> --refresh
```

`paseo usage` 等同于 `paseo usage ls`。摘要按账号对时间窗口和余额分组，并显示报告 ID、来源和账号标签、状态以及获取时间戳。缺失的值显示为 `-`；不可用和失败的报告会附带原因。

把列表中的完整报告 ID 复制到 `inspect` 中，可以查看重置时间、余额和单位、套餐详情、提供的预测，以及附带恢复说明的登录失败信息。报告 ID 需要完全匹配。

`--agent` 选择与某个 Agent 关联的账号配额。它不会统计该 Agent 的 token 消耗或费用。请使用完整的 Agent ID，并且不要把 `--agent` 与 `inspect` 一起使用。

查询会在可用时使用主机的五分钟缓存。添加 `--refresh` 可以绕过缓存。使用 `--host` 或 `--home` [选择一个 daemon](#select-one-daemon)。不支持用量来源的主机会返回一条更新提示。

### 在脚本中使用用量 {#usage-in-scripts}

```bash
paseo usage ls --json
paseo usage inspect <report-id> --json
paseo usage ls --quiet
```

列表的 JSON 始终是一个数组，没有返回报告时为 `[]`。inspect 的 JSON 是一个报告条目。每个条目包含 `id`、`sourceId`、`sourceLabel`、`account`、`fetchedAt` 和一个嵌套的 `report`。访问其数据之前，请先读取 `report.status`：

| 状态          | 字段                                                       |
| ------------- | ---------------------------------------------------------- |
| `available`   | `windows`，以及可选的 `planLabel`、`balances` 和 `details` |
| `unavailable` | `problem`，说明凭据过期、被拒绝或缺少配额                  |
| `error`       | `error`，失败信息                                          |

条目还可能包含 `loginErrors`。结构化输出会保留数值和可选字段。支持标准的 `--format yaml`、`--no-headers` 和 `--no-color` 选项；`--quiet` 输出完整的报告 ID。

查询完成时以状态 `0` 退出，即使个别报告不可用或失败也是如此。连接或请求失败、不支持的主机、未知的报告 ID 以及相互冲突的选择器会以状态 `1` 退出，并把错误写到 stderr。结果为空时，人类可读的输出会显示 **No usage reports returned**；这并不能说明每个来源的账号发现是否都成功了。

## Provider 诊断 {#provider-diagnostics}

让 daemon 检查它实际使用的 Provider 环境：

```bash
paseo provider diagnostic claude
paseo provider diagnostic codex --json
paseo --host devbox:6767 provider diagnostic opencode
```

诊断信息包括配置的命令、daemon 的 `PATH` 和 shell、匹配到的二进制文件、解析出的路径、版本、模型数量和 Provider 状态。对于远程 daemon，请使用全局的 `--host` 选项。这与 **设置 → 你的主机 → Providers → 对应 Provider → 诊断** 下显示的诊断相同。

## 运行 Agent {#running-agents}

使用 `paseo run` 启动一个带任务的新 Agent：

```bash
paseo run "implement user authentication"
paseo run --provider codex "refactor the API layer"
paseo run --no-wait "run the focused test suite"
paseo run --output-schema schema.json "name this branch"
paseo run --new-workspace worktree --worktree-mode branch-off --new-branch feature/x --base origin/main "implement feature X"
paseo run --workspace <workspace-id> "review the current diff"
paseo run --output-schema schema.json "extract release notes"
paseo run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"
```

在人工操作的 shell 中，不带参数的 `paseo run` 会为当前目录创建一个新的本地工作区。使用 `--workspace <id>` 把 Agent 加入一个已有的工作区，或者使用 `--new-workspace local|worktree` 为这次运行显式创建一个单独的工作区。

创建 worktree 时接受 `--worktree-mode branch-off|checkout-branch|checkout-pr`，以及相应的 `--new-branch`/`--base`、`--branch` 或 `--pr-number`/`--forge` 选项。使用 `--worktree-slug` 选择托管目录的 slug。

当一个已有的 Paseo Agent 运行同样的命令时，Paseo 会通过 `PASEO_AGENT_ID` 识别它。如果没有显式指定位置，新的 Agent 会成为它在同一工作区中的子 Agent。`--workspace` 可以把这个子 Agent 放到其他地方，而不改变它的父 Agent。

使用 `--output-schema` 只返回符合 schema 的 JSON 输出。你可以传入 schema 文件路径，或内联的 JSON schema 对象。此模式不能与 `--no-wait` 一起使用。

`paseo run` 默认等待完成。使用 `--no-wait` 可以立即返回，同时让 Agent 继续运行，`paseo send` 也使用同一个参数。

旧的 `run --background` 和 `-d` 别名仍然表示 `--no-wait`。它们已被弃用，不会出现在帮助中，并会向 stderr 输出警告。请在脚本中使用 `--no-wait`。工作区的可见性通过 `workspace create --background` 单独选择；本版本不会改变 `run --background` 的含义。

## 项目 {#projects}

把当前目录注册为项目，然后列出 daemon 知道的项目：

```bash
cd ~/dev/my-app
paseo project create
paseo project ls
```

使用 `paseo project ls` 中的项目 ID 重命名、重置或删除项目：

```bash
paseo project rename <project-id> "My app"
paseo project rename <project-id> --reset
paseo project delete <project-id>
```

`--reset` 恢复由项目目录推导出的名称。删除项目会归档它的活动工作区，并把项目从 Paseo 中移除。它不会删除项目目录。

对于本地 daemon，`paseo project create [path]` 默认使用当前目录，并在 CLI 所在机器上解析相对路径。当你使用全局的 `--host` 选项或 `PASEO_HOST` 时，请提供目标 daemon 能访问的路径：

```bash
paseo --host devbox:6767 project create /srv/repos/api
```

远程 daemon 会在它自己的机器上解释这个路径。项目如何对工作目录和会话分组，见[工作区](/docs/workspaces)。

## 工作区 {#workspaces}

如果你想在启动 Agent 之前先准备好文件，可以单独创建工作区：

```bash
paseo workspace create --isolation local --path ~/dev/my-app --title main

paseo workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base origin/main

paseo workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy

paseo workspace create \
  --isolation worktree \
  --path ~/dev/my-app \
  --mode checkout-pr \
  --pr-number 2186
```

添加 `--background` 可以把工作区从默认的发现结果中隐藏。它的 Agent 和终端保留普通的历史记录、持久化、钩子和重启恢复。`--no-background` 显式覆盖从调用方工作区继承的设置；省略时，由 Paseo Agent 运行则继承，在人工操作的 shell 中默认为 false。可见性只能在创建时设置。

```bash
paseo workspace create --isolation local --background --path /path/to/repo
paseo run --workspace <workspace-id> --no-wait "review the checkout flow"
```

无论在列表中是否可见，都可以通过确切的工作区 ID 和 Agent ID 访问它们。

然后列出、使用、重命名或归档它：

```bash
paseo workspace ls
paseo workspace ls --background               # Also include background workspaces
paseo run --workspace <workspace-id> "implement authentication"
paseo workspace rename <workspace-id> "Auth rework"
paseo workspace rename <workspace-id> --reset   # back to the branch or directory name
paseo workspace archive <workspace-id>
```

当 Paseo 无法从源检出推断代码托管平台时，为 PR 检出添加 `--forge <name>`。setup 钩子和服务见 [Git worktree](/docs/worktrees)。

## 终端 {#terminals}

当多个工作区共享同一个目录时，请使用工作区 ID：

```bash
paseo terminal create --workspace <workspace-id> --name Development
paseo terminal ls --workspace <workspace-id> --json
paseo terminal send-keys <terminal-id> -l "echo ready"
paseo terminal send-keys <terminal-id> Enter
paseo terminal capture <terminal-id>
paseo terminal kill <terminal-id>
```

创建时默认使用工作区目录。添加 `--cwd <absolute-path>` 可以修改进程目录，同时仍由该工作区拥有。未知或已归档的工作区 ID 会失败。

不带 `--workspace` 时，创建会打开 `--cwd` 或当前目录对应的项目，并复用其中最早的活动工作区。不带 `--workspace` 的列表会按 `--cwd` 或当前目录过滤，可能包含多个工作区。`ls --all` 列出主机上的所有终端，不能与目录或工作区过滤条件一起使用。

创建和列表的结果包含 `id`、`name`、`cwd` 和 `workspaceId`。使用 `--json` 获得结构化输出，使用全局的 `--host` 选项指定另一个 daemon。这些命令需要一个支持[工作区终端 API](/docs/sdk/reference#clientterminals) 的主机；较旧的主机会返回一条更新提示。

## 工作区脚本 {#workspace-scripts}

列出、启动和停止在工作区的 `paseo.json` 中配置的脚本：

```bash
paseo script ls
paseo script start web
paseo script stop web
```

Paseo 默认选择目录为当前目录的工作区。传入 `--cwd <path>` 选择另一个目录，当一个目录有多个工作区时传入 `--workspace <workspace-id>`。使用全局的 `--host` 选项指定另一个 daemon。这些命令也接受 `--json` 等标准输出选项。

输出包含每个脚本的生命周期和受监管的终端 ID。服务还包含它们分配到的端口、代理 URL 和健康状态。`paseo.json` 的配置见 [Git worktree](/docs/worktrees#scripts-and-services)。

## 插件 {#plugins}

> **信任你添加的每一个插件**。`paseo plugin add` 和 `paseo plugin install` 的含义是“我信任这个代码库”。插件的服务端代码和 Git 准备命令在 daemon 主机上以 daemon 用户的权限运行，没有沙盒；客户端贡献在 Paseo 内部运行。依赖和将来的更新也是这个决定的一部分。使用全局的 `--host` 选项时，命令在远程 daemon 主机上运行。

在 daemon 上创建和管理受信任的插件：

```bash
paseo plugin init ./plugin
paseo plugin install ./plugin
paseo plugin add owner/slug
paseo plugin add git:owner/repository
paseo plugin add https://gitlab.com/group/repository.git --ref main
paseo plugin add git:owner/monorepo:plugins/review
paseo plugin ls [id]
paseo plugin update my-plugin
paseo plugin update --all
paseo plugin reload my-plugin
paseo plugin logs my-plugin
paseo plugin disable my-plugin
paseo plugin enable my-plugin
paseo plugin remove my-plugin
```

`paseo plugin reload <id>` 报告重新加载本身的结果：在 daemon 停止并启动插件期间，无论耗时多久，它都会等待，并且会排在 daemon 的其他插件工作之后。取消命令或丢失连接不会停止 daemon 的工作，也没有任何列表或日志条目能确定被取消的重新加载做了什么——这些中间状态见[插件参考](/docs/plugins/reference)。再次运行重新加载才能得到结果：它会等待尚未完成的那一次，然后再停止并启动插件一次。

不带前缀的 `owner/slug` 会安装经过审查的注册表展示项。GitHub 源码使用 `git:owner/repository`，本地目录使用 `./plugin`。对于 monorepo 中的插件，追加 `:<directory>`。

`paseo plugin ls [id]` 不会联系远程。`paseo plugin logs <id>` 返回插件最近的 daemon 端 stdout 和 stderr。添加 `--json` 获得结构化条目，或运行 `paseo --host <target> plugin logs <id>` 查看另一个 daemon。安装、信任、生命周期和日志保留行为见[插件参考](/docs/plugins/reference)。

## 列出 Agent {#listing-agents}

```bash
paseo ls                    # Non-archived agents in active workspaces
paseo ls -a                 # Also include archived agents
paseo ls -g                 # Non-archived agents across all workspaces
paseo ls -a -g --json       # All agents, including archived, as JSON
paseo ls --background       # Also include agents in background workspaces
```

## 流式输出 {#streaming-output}

使用 `paseo attach` 实时查看 Agent 的输出流：

```bash
paseo attach abc123   # Attach to agent (Ctrl+C to detach)
```

Agent ID 可以缩写，只要 `abc` 没有歧义就可以使用。

## 发送消息 {#sending-messages}

向正在运行或空闲的 Agent 发送后续任务：

使用 `paseo ls` 中接收方的 Agent ID，或者[从 Agent 的标签页复制](/docs/orchestration-workflows#send-a-prompt-to-another-agent)。

```bash
paseo send <id> "now run the tests"
paseo send <id> --image screenshot.png "what's wrong here?"
paseo send <id> --no-wait "run this task"
paseo send <id> --behavior interrupt "stop and do this instead"
```

由 Agent 发起的发送（设置了 `PASEO_AGENT_ID`）默认引导正在进行的轮次。其他发送默认中断它。使用 `--behavior steer` 或 `--behavior interrupt` 覆盖默认行为。引导使用与客户端相同的后备方式：如果无法引导，正在进行的轮次会被中断并替换。

## 查看日志 {#viewing-logs}

```bash
paseo logs <id>                  # Full timeline
paseo logs <id> -f               # Follow (streaming)
paseo logs <id> --tail 10        # Last 10 entries
paseo logs <id> --filter tools   # Only tool calls
```

## 等待 Agent {#waiting-for-agents}

阻塞直到 Agent 完成当前任务：

```bash
paseo wait <id>
paseo wait <id> --timeout 60   # 60 second timeout
```

适用于脚本中，或一个 Agent 需要等待另一个 Agent 的情况。

## 定时任务 {#schedules}

按 cron 定时任务运行 Agent。CLI 也接受简单的节奏预设，并把它们编译为 cron。完整参考见[在 CLI 中使用定时任务](/docs/schedules-cli)。

```bash
paseo schedule create --every 30m --cwd ~/dev/my-app "Continue the refactor and leave a note."
paseo schedule ls
paseo schedule pause <id>
```

## 权限 {#permissions}

Agent 在执行某些操作时可能会请求权限。在 CLI 中管理这些请求：

```bash
paseo permit ls                # List pending requests
paseo permit allow <id>        # Allow all pending for agent
paseo permit deny <id> --all   # Deny all pending
```

## Agent 模式 {#agent-modes}

修改 Agent 的运行模式（因 Provider 而异）：

```bash
paseo agent mode <id> --list   # Show available modes
paseo agent mode <id> bypass   # Set bypass mode
paseo agent mode <id> plan     # Set plan mode
paseo agent detach <id>        # Make a subagent top-level
```

解除父子关系是一个显式的生命周期操作，而不是创建时的参数。Agent 会继续运行；只有它与父 Agent 的关系发生变化。

## 管理 daemon {#daemon-management}

定义一次实例，然后启动它保存的配置：

```bash
paseo daemon config set daemon.listen 127.0.0.1:6799 --home ~/paseo-test
paseo daemon config set daemon.relay.enabled false --home ~/paseo-test
paseo daemon start --home ~/paseo-test
paseo project ls --home ~/paseo-test
paseo daemon restart --home ~/paseo-test
paseo daemon stop --home ~/paseo-test
```

`start` 在后台运行，并报告实际的监听地址和进程管理器的 PID。它只接受主目录选择和 `--timeout <seconds>`（默认 600）。如果等待超时，进程管理器仍会继续运行：请使用输出的状态、日志和停止说明。worker 在就绪之前退出会导致启动失败。

`restart` 请求现有的进程管理器替换 worker。它会重新读取文件，并保留进程管理器原始的环境变量和参数。成功表示已有另一个 worker 就绪，对于主目录目标还会跟随已变更的地址。它从不启动已停止的 daemon，也不会刷新进程管理器的二进制文件。超时时会报告请求是否已被确认；它无法证明重连失败的原因。

`stop --home` 会等待该本地进程管理器退出。在 POSIX 上，它向进程管理器发送信号，不联系任何 TCP 端点。在 Windows 上，它使用已就绪 daemon 的关闭 RPC；未绑定的实例需要显式的 `--force`。`--force` 允许在正常关闭超时（默认 15 秒）后强制清理进程树。`stop --host` 只报告 **shutdown requested**；不会验证远程进程是否退出。在捕获的进程管理器退出后，服务管理器可能会启动另一个实例。

`status` 分别显示本地进程管理器的状态、它发布的端点、配置的地址和 RPC 可达性。已停止的主目录从不会在其配置的地址上被探测。未绑定但仍在运行的进程管理器显示为 **not ready**。如果经过身份验证的本地连接仍然打开，但状态详情超时，结果仍为 `reachable`，并附带一条说明详情不可用的备注。worker 和 Provider 字段会被省略。显式的 `--host` 查询在其状态请求失败时仍然会失败。

`reload` 校验文件、应用运行时安全的更改，并报告 `appliedPaths`、`restartRequiredPaths` 和 `overrideControlledPaths`。它从不会隐式重启。使用 `--json` 或 `--format yaml` 获得结构化结果。缺少这项能力的较旧主机会报告需要更新。

根级别名 `start`、`status`、`restart`、`reload` 和 `pair` 与 `daemon` 下的命令相同。根级的 `run` 和 `stop` 仍然是 Agent 操作。

### 前台部署与迁移 {#foreground-deployments-and-migration}

在前台部署命令中使用环境变量覆盖：

```bash
PASEO_LISTEN=127.0.0.1:6799 PASEO_RELAY_ENABLED=false paseo daemon run --home ~/paseo-test
```

它会一直保持附着，直到进程管理器退出或你取消，没有就绪超时。worker 重启会保留这些启动输入。要修改它们，请停止并重新启动部署。如果主目录中已经有一个运行中的进程管理器，`run` 会返回 `already_running`，而不会接管或启动前台进程。

托管的 `start` 会忽略继承来的 daemon 设置覆盖项，包括 `PORT`、`PASEO_LISTEN`、中继、语音和 Web UI 设置。它会保留 Provider 凭据以及可执行文件/运行时控制项。`start --foreground` 已被移除；请使用 `daemon run`。以前的 start/restart 配置参数，例如 `--port`、`--no-relay` 和 `--web-ui`，会在产生任何副作用之前失败，并给出相应的 `config set` 迁移方式。见[配置编辑](/docs/configuration#apply-changes)。

### 选择一个 daemon {#select-one-daemon}

每个连接 daemon 的 CLI 命令都接受全局的 `--home` 或 `--host`，放在命令之前或之后均可。主目录选择本地进程管理器发布的端点；主机选择一个显式的端点。不存在退回到配置地址或默认端口的行为。

| 选择器                                   | 结果                                 |
| ---------------------------------------- | ------------------------------------ |
| `--home`                                 | 该本地主目录，覆盖两个环境变量选择器 |
| `--host`                                 | 该端点，覆盖两个环境变量选择器       |
| 同时提供两个参数，或重复且相互冲突的参数 | `TARGET_AMBIGUOUS`                   |
| 只有 `PASEO_HOME` 或只有 `PASEO_HOST`    | 对应的目标                           |
| 两个环境变量选择器都存在，且没有参数     | `TARGET_AMBIGUOUS`                   |
| 都没有                                   | 默认的本地主目录 `~/.paseo`          |

仅限本地的 `start`、`daemon run`、`config`、`onboard` 和 `set-password` 会拒绝显式的 `--host`，并忽略 `PASEO_HOST`。端点操作保留 TCP、Unix 套接字、Windows 管道、SSH 和配对信息等传输方式。在宿主机上控制容器的 CLI 需要 `--host` 或 `PASEO_HOST`。

## Hub {#hub}

```bash
paseo hub login [url]          # Approve and store organization-scoped CLI access
paseo hub init                 # Create and optionally deploy a starter trigger here
paseo hub connect [url]        # Enroll this daemon using CLI access
paseo hub projects             # List legacy projects in the authenticated organization
paseo hub status               # Show the current Hub relationship
paseo hub permissions list     # Show what this Hub may do on this daemon
paseo hub permissions grant hub.execute    # Let Hub automations run agents here
paseo hub permissions revoke hub.execute   # Take it back
paseo hub disconnect           # End it
paseo hub deploy               # Validate and install .paseo/triggers/*.yml
paseo hub deploy --dry-run     # Validate without installing
paseo hub deploy -p <project>   # Deploy an existing legacy project bundle
paseo hub logout               # Remove the active stored CLI login
```

请在仓库根目录运行 deploy。它默认按确定的路径顺序读取所有直接位于 `.paseo/triggers/` 下的 `*.yml` 文件。它会先校验所有触发器，再逐个安装。如果在前面的安装成功之后某个安装失败，错误信息会列出已安装的文件。`--dry-run` 只做校验；它不会创建或激活修订。

对于已有的旧版文件包，传入 `-p, --project <slug>`：包括 `.paseo/hub.yml`、直接位于 `.paseo/workflows/` 下的 `*.yml` 文件，以及被引用的 workflow 片段。见[从 CLI 部署](/docs/hub/configuration#deploy-from-the-cli)。

`login` 会打开 Hub 的批准页面，并在 `PASEO_HOME` 下保存一个持久的、组织范围的 CLI 凭据。在交互式终端中，它会提议连接这个 daemon，然后单独询问是否允许 Hub 自动化在这里运行 Agent。连接默认为是；执行权限默认为否。随后它会链接到 Hub 的 **Triggers** 页面，并输出 `paseo hub init`，以便用代码完成设置。`--json` 和非 TTY 的登录只执行登录，从不提示。保存的登录与 `connect` 创建的 daemon 关系是分开的。

`init` 需要 TTY。它会根据需要登录并连接 daemon，然后列出组织中可以支撑入门触发器的应用连接。只有一个可用连接时会自动选中；有多个时，由你选择一个 **Trigger connection**。如果没有任何连接就绪，设置会引导你前往 **Hub → Apps**，并在选择 Agent 或写入文件之前停止。

设置会询问要运行哪个 Agent Provider、模型和模式。Provider 必须已启用，并且同时提供可选择的模型和执行模式。建议的模型和模式条目是 daemon 的默认值；没有默认值时仍需显式选择模式。Hub 在部署前会对照 daemon 校验这项选择，并且其无人值守的运行只接受 Claude、Codex 和 OpenCode。`deploy` 会执行相同的检查，因此需要指定的 daemon 已连接。随后设置会询问允许触发机器人的身份：GitHub 用户名、Slack 成员 ID 或 Discord 用户 ID。它会校验触发器，写入 `.paseo/triggers/<provider>-help.yml`，并询问是否部署。替换该文件需要确认；已有的旧版文件包和其他触发器文件会被保留。见[生成的入门触发器](/docs/hub/configuration#generated-starter-trigger)。

交互式退出会检查同一地址的 daemon 关系，并在删除登录之前询问是否断开。选择否时只删除登录。JSON 和非交互式的退出从不提示，也不会隐式断开；`--disconnect-daemon` 是供自动化使用的显式方式，`--force` 作用于该 daemon 断开操作。如果请求的断开失败，登录会被保留。

每个命令在执行 Hub 或 daemon 工作之前，都会解析并规范化它的目标。地址的优先级依次为：显式的命令地址或 `--hub`、`PASEO_HUB_URL`、当前保存的登录地址，最后是托管版默认地址 `https://hub.paseo.sh`。托管版默认地址从不会覆盖当前的登录。凭据的优先级依次为：`--api-key <secret>`、`PASEO_HUB_API_KEY`，然后是与解析出的地址完全匹配的已保存登录。保存的凭据从不会发送到其他地址。通过参数或环境变量传入的 API 密钥不会被保存。

人类可读的输出会在每个操作之前报告解析出的目标。JSON 输出让 stdout 保持机器可读，并包含规范化后的 Hub 地址。文件包诊断会指出路径，但不会输出配置内容或凭据。

见 [Hub 中的 daemon](/docs/hub/daemons)、[Hub 配置](/docs/hub/configuration)和 [Hub 公开 API](/docs/hub/api)。

## 连接远程 daemon {#connecting-to-a-remote-daemon}

全局的 `--host` 选项接受本地目标（`host:port`、Unix 套接字或 Windows 管道），也接受配对信息 URL，即移动应用在扫码配对时使用的同一个 `https://app.paseo.sh/#offer=...` 链接。使用配对信息 URL 时，CLI 会通过 Paseo 中继以端到端加密的方式连接，因此你可以驱动另一台机器上的 daemon，而不必把它暴露在网络上。

从你要控制的 daemon 获取配对信息 URL：

```bash
paseo daemon pair          # prints the QR and link when relay is enabled
paseo daemon pair --relay  # enables relay without prompting
paseo daemon pair --json   # structured output; never prompts
```

新安装默认关闭中继。中继被禁用时会返回 `RELAY_DISABLED` 错误；传入 `--relay` 表示明确同意。对于已停止的主目录，配对会被标记为离线；`--relay` 会保存中继启用设置，配对信息中会包含一条启动说明。运行中但不可达的主目录从不会退回到离线身份。中继配对是端到端加密的。见[安全](/docs/security)。

在任何地方使用它：

```bash
paseo --host 'https://app.paseo.sh/#offer=eyJ2IjoyLC...' ls
paseo --host "$OFFER_URL" run "fix the failing tests"
```

你也可以通过 `PASEO_HOST` 设置一次，而不必在每条命令中传入 `--host`。显式的参数会覆盖环境变量。

## 多 Agent 工作流 {#multi-agent-workflows}

CLI 的设计初衷之一就是供 Agent 自己使用。你可以让一个 Agent 启动子 Agent 来并行工作：

```bash
# Agent A spawns Agent B and waits for it
agent_id=$(paseo run --no-wait --quiet --title api-agent "implement the API")
paseo wait "$agent_id"
paseo logs "$agent_id" --tail 5
```

由于 Agent A 的 ID 存在于环境变量中，除非指定了 `--workspace`，Agent B 会作为它的子 Agent 创建在同一个工作区中。

简单的实现加验证循环：

```bash
# Requires jq
while true; do
  paseo run --provider codex "make the tests pass" >/dev/null

  verdict=$(paseo run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done
```

这种模式支持分层的任务分解：一个主导 Agent 可以拆分工作、委派给专门的 Agent，并汇总结果。

## 输出格式 {#output-formats}

大多数命令都支持多种输出格式，便于编写脚本：

```bash
paseo ls --json                # JSON output
paseo ls --format yaml         # YAML output
paseo ls -q                    # IDs only (quiet)
```

## 全局选项 {#global-options}

- `--host <target>`，连接另一个 daemon（`host:port`、Unix 套接字，或用于中继的 `https://app.paseo.sh/#offer=...`）。见[连接远程 daemon](#connecting-to-a-remote-daemon)。
- `--json`，JSON 输出
- `-q, --quiet`，最少的输出
- `--no-color`，禁用颜色
