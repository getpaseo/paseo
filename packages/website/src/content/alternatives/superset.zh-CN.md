---
title: 支持原生移动端的开源 Superset 替代品
description: Paseo 是一个采用 Apache-2.0 许可的 Superset 替代品，无需账号即可在本地运行，并支持覆盖其服务端和客户端的应用插件。
nav: Superset
order: 51
---

# Paseo 与 Superset 对比

Superset 是一个源代码可见的桌面工作区，用于在并行的 Git worktree 中运行 CLI 编码 Agent。它包括 CLI、SDK、MCP 服务器和远程主机。

Paseo 可以从桌面端、移动端、Web 和 CLI 编排编码 Agent。它以 Apache-2.0 许可开源。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

Superset 提供一个以终端为中心的工作区，用于在并行的 Git worktree 中运行许多 CLI Agent。它需要 Superset 账号和 GitHub 登录，其源代码以 Elastic License 2.0 发布。

Paseo 无需账号即可在本地运行，采用 Apache 2.0 许可，为受支持的 Agent harness 提供结构化界面，并支持带有服务端行为和原生客户端组件的应用插件。

## 许可证 {#license}

Paseo 以 Apache-2.0 许可开源。你可以审计、fork、修改和重新分发它。

Superset 以 Elastic License 2.0 发布源代码。你可以使用和修改它，但该许可证限制把 Superset 作为托管服务提供，也限制绕过受许可证保护的功能。

## 架构与访问 {#architecture-and-access}

两者都在你掌控的机器上运行 Agent，并且可以连接到远程主机。

Paseo 的 daemon 独立于它的客户端运行。桌面端、Web、移动端、CLI、SDK 和 MCP 客户端都可以直接连接，本地使用不需要账号。

Superset 在打开应用时需要 Superset 账号和 GitHub 登录。它的同步、远程访问和团队工作流使用 Superset 的云服务。

## Provider {#providers}

Superset 支持许多基于 CLI 的编码 Agent，并允许你添加自定义的终端 Agent。

Paseo 通过原生的结构化 harness 运行 Claude Code、Codex、OpenCode、Pi、Antigravity 和 Muse Code，并通过 ACP 目录支持另外 30 多个 Agent，以及任意自定义的 CLI Agent。查看[所有支持的 Provider](/agents)。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

Superset 没有公开文档化的应用扩展 API，无法同时添加服务端行为和原生客户端组件。

## 工作区与审查 {#workspaces-and-review}

两者都提供 Git worktree、拆分窗格、终端、diff 审查、应用内浏览器、GitHub 工作流、定时任务和远程主机。

Paseo 为受支持的 Provider 提供结构化的聊天界面，支持模式、斜杠命令、工具调用和文件附件。Superset 可以在终端窗格中运行任何 CLI Agent，并为受支持的 Agent 添加生命周期状态。

Paseo 还为每个 worktree 提供独立的服务 URL，例如 `web--fix-auth--my-app.localhost`，因此并行的开发服务器不会争抢端口。

## 自动化 {#automation}

两者都通过 CLI、TypeScript SDK 和 MCP 服务器提供工作区和 Agent 操作。它们可以创建工作区、启动 Agent、跟踪进度和管理定时工作。

## 价格 {#pricing}

Paseo 免费，没有席位限制。

Superset 有一个免费的个人版。团队功能、远程访问和集成属于它的付费套餐。

## 对比 {#comparison}

|                                | Paseo                                                                              | Superset                                               |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 许可证                         | 开源（Apache-2.0）                                                                 | 源代码可见（Elastic License 2.0）                      |
| 需要账号                       | 否                                                                                 | 是，需要 GitHub 登录                                   |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（macOS，Linux 为实验性）                            |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | 即将推出                                               |
| CLI                            | 是（应用能做的都能做）                                                             | 是（另有 SDK 和 MCP 服务器）                           |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | 是（主机服务端；付费套餐通过 Superset 云提供远程访问） |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | Superset 云服务（付费套餐）                            |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | -                                                      |
| SSH 访问                       | 是                                                                                 | -                                                      |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | CLI Agent、自定义终端 Agent                            |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 是（Git worktree）                                     |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | 是（为受支持的 Agent 提供生命周期状态）                |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | 是（CLI、SDK 和 MCP 服务器可以创建工作区并启动 Agent） |
| 编辑器                         | 是                                                                                 | -                                                      |
| 终端                           | 是                                                                                 | 是                                                     |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | 是                                                     |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | GitHub                                                 |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 是                                                     |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | 端口检测                                               |
| 定时任务与 heartbeat           | 是                                                                                 | 是（定时任务）                                         |
| 套餐用量                       | 是                                                                                 | -                                                      |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                                     |
| 语音                           | 是（本地语音输入、实时语音）                                                       | -                                                      |
| 遥测                           | 无                                                                                 | -                                                      |

另请参阅：[Paseo 与 Conductor 对比](/alternatives/conductor)、[Paseo 与 OpenChamber 对比](/alternatives/openchamber)、[Paseo 与 Happy Coder 对比](/alternatives/happy-coder)。
