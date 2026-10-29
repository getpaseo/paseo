---
title: 支持 worktree 和多 Provider 的 Happy Coder 替代品
description: Paseo 为远程编码 Agent 工作流加入了托管的 worktree、覆盖桌面端和移动端的原生客户端，以及可扩展的 daemon 和客户端界面。
nav: Happy Coder
order: 53
---

# Paseo 与 Happy Coder 对比

Happy Coder 在其 macOS、Web、iOS 和 Android 应用之间连接 Claude Code 和 Codex 会话。它在你的笔记本上包装 Agent CLI，并通过端到端加密的中继同步会话。它以 MIT 许可开源。

Paseo 是一个开源的 Agent 式开发环境。你可以在各自独立的 worktree 中并行运行多个 Agent，编辑文件，审查 diff 和拉取请求，并用终端和内置的桌面浏览器测试你的应用。它以 Apache-2.0 许可提供桌面端、移动端、Web 和 CLI。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

Happy Coder 专注于通过端到端加密的中继，把 Claude Code 和 Codex 会话连接到它的移动端、Web 和 macOS 客户端。

Paseo 同样支持这两个 Provider，还支持 OpenCode、Pi、ACP Agent 和自定义 Provider。它还通过同一个 daemon 管理工作区、worktree、服务、拉取请求审查和应用插件。

## 架构 {#architecture}

Paseo 在自己的 daemon 中运行 Agent。daemon 负责 Agent 的生命周期、worktree 和开发服务器。客户端通过 websocket 连接并驱动 daemon。

Happy Coder 在你的笔记本上通过它的 CLI 运行 Agent，并通过端到端加密的中继把会话同步到它的桌面端、移动端和 Web 客户端。

## 窗格 {#panes}

Paseo 应用支持拆分窗格和标签页（⌘D 垂直拆分，⌘⇧D 水平拆分）。窗格可以是与 Agent 并排的终端、diff 查看器，以及用于测试运行中服务的浏览器。

Happy Coder 的 macOS 应用把对话与文件、diff、终端和预览并排放置。

## GitHub {#github}

Paseo 应用可以完成提交、推送、创建 PR、关注检查和审查，以及合并。

## 移动端 {#mobile}

移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。Happy Coder 也提供原生的 iOS 和 Android 应用。

## Provider {#providers}

Paseo 原生支持 Claude Code、Codex、OpenCode、Pi、Antigravity 和 Muse Code，并通过应用内目录支持另外 30 多个 Agent，包括 GitHub Copilot、Cursor、Gemini CLI 和 Amp。Paseo 支持 [Agent Client Protocol](https://agentclientprotocol.com)，因此任何 ACP Agent 都可以使用。自定义 Provider 可以运行任何 CLI Agent。查看[所有支持的 Provider](/agents)。

Happy Coder 运行 Claude Code 和 Codex。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

Happy Coder 没有公开文档化的应用扩展 API，无法同时添加服务端行为和原生客户端组件。

## Worktree 与服务 {#worktrees-and-services}

Paseo 在各自的 git worktree 中运行每个 Agent。每个 worktree 都有独立的开发服务器 URL，例如 `web--fix-auth--my-app.localhost`，因此并行的 Agent 不会争抢同一个端口。

Happy Coder 可以在选定的机器路径中启动 Agent，包括已有的 Git worktree。它目前不会创建 worktree，也不管理其生命周期。

## CLI {#cli}

Paseo 有一个与应用功能对应的 CLI：

```bash
paseo run --provider codex "implement OAuth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` 连接到远程 daemon。`paseo schedule` 按 cron 运行 Agent。

Happy Coder 提供 CLI，用于启动被包装的会话，以及创建远程会话、向其发送消息、监控和停止远程会话。它没有公开文档化定时任务或循环。

## 语音 {#voice}

两款产品都支持语音交互。Paseo 可以在设备上本地运行语音转文字和文字转语音。

## 对比 {#comparison}

|                                | Paseo                                                                              | Happy Coder                               |
| ------------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| 许可证                         | 开源（Apache-2.0）                                                                 | 开源（MIT）                               |
| 需要账号                       | 否                                                                                 | -                                         |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（macOS）                               |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | 是（原生）                                |
| CLI                            | 是（应用能做的都能做）                                                             | 是（启动和控制会话）                      |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | -                                         |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | 是（端到端加密）                          |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | -                                         |
| SSH 访问                       | 是                                                                                 | -                                         |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | Claude Code、Codex                        |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 使用已有的 worktree 路径，不管理 worktree |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | 是（包装 Agent CLI）                      |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | -                                         |
| 编辑器                         | 是                                                                                 | -                                         |
| 终端                           | 是                                                                                 | 是                                        |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | 是                                        |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | -                                         |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 是（预览）                                |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | -                                         |
| 定时任务与 heartbeat           | 是                                                                                 | -                                         |
| 套餐用量                       | 是                                                                                 | -                                         |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                        |
| 语音                           | 是（本地语音输入、实时语音）                                                       | 是                                        |
| 遥测                           | 无                                                                                 | -                                         |

另请参阅：[Paseo 与 Conductor 对比](/alternatives/conductor)、[Paseo 与 Superset 对比](/alternatives/superset)、[Paseo 与 OpenChamber 对比](/alternatives/openchamber)。
