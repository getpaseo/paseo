---
title: 面向 Agent 式开发的 Orca 替代品
description: Paseo 是一个开源的 Agent 式开发环境，提供并行 worktree、编辑器、终端、diff、拉取请求以及内置浏览器。
nav: Orca
order: 57
---

# Paseo 与 Orca 对比

Orca 是一款以 MIT 许可发布的桌面应用，用于在并行的 Git worktree 中运行终端编码 Agent。它包括一个移动伴侣应用、SSH worktree、远程 Orca 服务器、嵌入式浏览器和 CLI。

Paseo 是一个开源的 Agent 式开发环境。你可以在各自独立的 worktree 中并行运行多个 Agent，编辑文件，审查 diff 和拉取请求，并用终端和内置的桌面浏览器测试你的应用。它以 Apache-2.0 许可提供桌面端、移动端、Web 和 CLI。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

Orca 围绕终端构建。每个 Agent 都运行在一个终端窗格中，实验性的 Chat UI 可以把受支持的 Agent 显示为聊天记录。Orca 围绕这些终端内置了大量工具。

Paseo 围绕与 Agent 的聊天构建。应用内置了每个开发者都会用到的功能：编辑器、终端、diff、拉取请求和浏览器。只有部分团队需要的功能，例如 issue 看板或云端虚拟机，则以插件的形式按需安装，因此你不用的东西不会碍事。

Orca 由 Stably AI 开发，这是一家获得风险投资的公司（Y Combinator）。Paseo 是独立的开源项目。

## 架构与远程机器 {#architecture-and-remote-machines}

Paseo 桌面应用会自动启动并管理一个本地 daemon。这个 daemon 负责 Agent 和工作区，因此其他客户端可以连接到同一个开发环境。桌面端、Web、移动端和 CLI 客户端可以直接连接、通过 SSH 连接，或者通过可选的端到端加密中继连接。你可以在笔记本、虚拟机、家用服务器或 Docker 中运行 daemon，并从任意客户端连接到其中任何一个。请参阅[连接](/docs/connectivity)。

Orca 默认在其桌面应用内运行，并通过两种方式访问其他机器。SSH worktree 让 Orca 运行时留在你的笔记本上，而在远程主机上运行选定的 worktree 和终端。远程 Orca 服务器（beta）在另一台机器上运行 Orca 桌面端或 `orca serve`，并让客户端与之配对。Orca 的文档建议为远程 Orca 服务器使用 Tailscale 或其他私有网络。

## 移动端与中继 {#mobile-and-the-relay}

两者都有 iOS 和 Android 应用。

Paseo 的移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。它们已在 App Store 和 Google Play 上架。要从手机连接，请开启中继并扫描二维码。daemon 主动向外连接到中继，你的手机在中继处与它会合，因此你不需要 VPN、端口转发、SSH 或账号。通信是端到端加密的，[中继服务器](https://github.com/getpaseo/paseo-relay)也是开源的。你也可以通过 Tailscale 直接连接。

Orca 的移动伴侣应用处于 beta 阶段，iOS 版在 App Store 上提供，Android 版以 APK 下载提供。它可以回复 Agent、以终端或 Chat UI 打开会话、提交更改，以及在配对的桌面端上创建工作区。Orca Relay 同样处于 beta 阶段，用于在手机与桌面不在同一网络时连接手机，并且需要登录 Orca 账号。没有 Orca Relay 时，手机需要通过局域网或 Tailscale 访问桌面端。

## 聊天 {#chat}

Paseo 在桌面端、Web 和移动端的主界面都是与 Agent 的聊天。Paseo 通过结构化的 harness 运行受支持的 Provider，因此消息、工具调用、权限请求、模式、斜杠命令和文件附件都来自 Agent 自己的协议。

Orca 的主界面是 Agent 的终端。它的 Chat UI 是在同一个终端会话之上的实验性视图，需要在 **Settings → Experimental** 中开启。它会解析 Claude、Codex、Grok 和 OMP 的聊天记录，而终端仍然是事实来源。

## Provider {#providers}

Orca 可以在终端中运行任何 CLI Agent，并列出了 30 多个受支持的 Agent。

Paseo 通过原生的结构化 harness 运行 Claude Code、Codex、OpenCode、Pi、Antigravity 和 Muse Code，并通过 ACP 目录支持另外 30 多个 Agent，以及任意自定义的 CLI Agent。查看[所有支持的 Provider](/agents)。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。插件可以添加工作区面板、侧边栏项、Command Center 条目、斜杠命令、Composer 胶囊、设置界面、主题、附件来源和 Agent Provider。它的服务端代码在 daemon 旁边运行，客户端代码则在每个已连接的客户端中运行：桌面端、浏览器、iOS 和 Android。

社区插件列在 [paseo.sh/plugins](/plugins) 上。

Orca 有一个默认关闭的实验性插件系统。Orca 插件可以添加在沙箱框架中渲染的桌面面板、命令、快捷键、语言包、虚拟机配方和 Agent 配置，并且可以从 git 市场安装。插件 worker 在桌面电脑上运行，Orca 没有公开文档化其移动应用中的插件界面。

## 范围 {#scope}

Orca 在核心应用中包含了许多工具：Monaco 代码编辑器、用于把浏览器中的页面元素发送给 Agent 的 Design Mode、computer use、Linear 和 Jira 看板、带用量跟踪的 Agent 账号切换，以及每个工作区的云端虚拟机配方。如果你希望在一个应用中直接获得这些功能而无需扩展，Orca 提供了它们。

Paseo 包含编辑器、终端、评论会发送给 Agent 的 diff 审查、GitHub、GitLab、Gitea、Forgejo 和 Codeberg 上的拉取请求、带元素选择器和 Agent 浏览器工具的浏览器、套餐用量、定时任务和 heartbeat。看板和云端虚拟机则由插件添加。

## 工作区与审查 {#workspaces-and-review}

两者都提供 Git worktree、拆分窗格、终端、diff 审查、应用内浏览器、拉取请求工作流以及定时运行 Agent。

Paseo 提供评论会发送给 Agent 的 diff 审查，并可以在 GitHub、GitLab、Gitea、Forgejo 和 Codeberg 上创建拉取请求。它还为每个 worktree 提供独立的服务 URL，例如 `web--fix-auth--my-app.localhost`，因此并行的开发服务器不会争抢端口。Orca 为 SSH worktree 提供端口转发，并支持 GitHub 以及 GitLab、Bitbucket、Azure DevOps 和 Gitea 上的拉取请求。

## 自动化 {#automation}

Paseo 通过 CLI、TypeScript SDK 和 MCP 服务器提供工作区和 Agent 操作：

```bash
paseo run --provider codex "implement OAuth"
paseo --host ssh://user@devbox run --cwd /srv/app "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

Orca 的 CLI 可以创建 worktree、驱动它的浏览器并管理自动化。Orca 会安装技能，让 Agent 可以调用同样的命令。

## 账号与遥测 {#accounts-and-telemetry}

Paseo 不需要账号，也不收集遥测数据。

本地使用 Orca 不需要账号。Orca Relay 和共享制品需要 Orca 账号。打包发布的 Orca 构建会发送匿名使用遥测数据，你可以关闭它。

## 对比 {#comparison}

|                                | Paseo                                                                              | Orca                                           |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------- |
| 许可证                         | 开源（Apache-2.0）                                                                 | 开源（MIT）                                    |
| 需要账号                       | 否                                                                                 | 本地使用不需要，中继需要 Orca 账号             |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（macOS、Linux、Windows）                    |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | 是（伴侣应用，beta）                           |
| CLI                            | 是（应用能做的都能做）                                                             | 是（worktree、浏览器、自动化）                 |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | 是（SSH worktree、远程 Orca 服务器 beta）      |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | 是（beta，需要 Orca 账号）                     |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | 是（局域网、Tailscale）                        |
| SSH 访问                       | 是                                                                                 | 是（SSH worktree）                             |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | 终端中的任意 CLI Agent，列出了 30 多个         |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 是（Git worktree）                             |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | 是（主界面，实验性 Chat UI）                   |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | 是（Agent 通过已安装的技能调用 Orca CLI）      |
| 编辑器                         | 是                                                                                 | 是（Monaco）                                   |
| 终端                           | 是                                                                                 | 是                                             |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | 是                                             |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | GitHub、GitLab、Bitbucket、Azure DevOps、Gitea |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 是（Design Mode）                              |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | SSH worktree 的端口转发                        |
| 定时任务与 heartbeat           | 是                                                                                 | 是（定时运行 Agent）                           |
| 套餐用量                       | 是                                                                                 | 是（用量跟踪、账号切换）                       |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 实验性，仅限桌面端                             |
| 语音                           | 是（本地语音输入、实时语音）                                                       | 语音输入                                       |
| 遥测                           | 无                                                                                 | 匿名使用数据，可选择退出                       |

另请参阅：[Paseo 与 Conductor 对比](/alternatives/conductor)、[Paseo 与 Superset 对比](/alternatives/superset)、[Paseo 与 OpenChamber 对比](/alternatives/openchamber)。
