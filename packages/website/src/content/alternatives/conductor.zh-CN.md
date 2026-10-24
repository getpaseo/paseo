---
title: 开源的 Conductor 替代品，支持 Linux、Windows 和移动端
description: Paseo 是一个开源的 Conductor 替代品，支持 Linux、Windows、原生移动应用、自托管的 daemon 以及可扩展的客户端。
nav: Conductor
order: 50
---

# Paseo 与 Conductor 对比

Conductor 是一款专有的 macOS 应用，用于在并行的 Git worktree 和托管的云端工作区中运行 Claude Code、Codex、Cursor 和 OpenCode。

Paseo 是一个开源的 Agent 式开发环境。你可以在各自独立的 worktree 中并行运行多个 Agent，编辑文件，审查 diff 和拉取请求，并用终端和内置的桌面浏览器测试你的应用。它以 Apache-2.0 许可提供桌面端、移动端、Web 和 CLI。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

Conductor 在 macOS 上免费提供本地工作区。它的托管云端工作区、API、协作功能以及即将推出的移动应用包含在每月 50 美元的 Pro 套餐中。

Conductor 完成了 2200 万美元的 A 轮融资，并且是专有软件。Paseo 是独立项目，采用 Apache 2.0 许可，支持 macOS、Linux、Windows、iOS 和 Android，并且可以连接到你掌控的机器。

## 架构 {#architecture}

Paseo daemon 作为独立进程运行。桌面端、Web、移动端和 CLI 都通过 websocket 连接到它。你可以在笔记本、虚拟机、Docker 或一组机器上运行 daemon，并从任意客户端连接到其中任何一个。

Conductor 通过其 macOS 应用运行本地工作区，并在托管的 Vercel 沙箱中运行云端工作区。它目前不支持把客户端连接到你自己运维的云主机。

## Provider {#providers}

Paseo 原生支持 Claude Code、Codex、OpenCode、Pi、Antigravity 和 Muse Code，并通过应用内目录支持另外 30 多个 Agent，包括 GitHub Copilot、Cursor、Gemini CLI 和 Amp。Paseo 支持 [Agent Client Protocol](https://agentclientprotocol.com)，因此任何 ACP Agent 都可以使用。自定义 Provider 可以运行任何 CLI Agent。查看[所有支持的 Provider](/agents)。

Conductor 支持 Claude Code、Codex、Cursor 和 OpenCode。

两者都使用你自己的 Provider 凭据。Paseo 启动安装在你机器上的 Provider。Conductor 捆绑了托管的 Claude Code 和 Codex 二进制文件，并为 Cursor 和 OpenCode 提供托管集成。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

Conductor 没有公开文档化的应用扩展 API，无法同时添加服务端行为和原生客户端组件。

## 窗格 {#panes}

Paseo 应用支持拆分窗格和标签页（⌘D 垂直拆分，⌘⇧D 水平拆分）。窗格可以是与 Agent 并排的终端、diff 查看器，以及用于测试运行中服务的浏览器。

## GitHub {#github}

Paseo 应用可以完成提交、推送、创建 PR、关注检查和审查，以及合并。

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

Conductor 把 API 列为 Pro 功能，但没有公开文档化与 Paseo 相当的面向用户的 CLI。

## Worktree 与服务 {#worktrees-and-services}

两者都把并行的 Agent 隔离在 git worktree 中。

Paseo 还为每个 worktree 提供独立的开发服务器 URL。两个 Agent 同时运行开发服务器时，会分别得到 `web--fix-auth--my-app.localhost` 和 `web--add-search--my-app.localhost`，而不会发生端口冲突。

## 移动端 {#mobile}

移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。Conductor 把它的移动应用列为 Pro 套餐下即将推出的功能。

## 语音 {#voice}

Paseo 支持本地的语音转文字和文字转语音。Conductor 目前没有公开文档化的语音界面。

## 对比 {#comparison}

|                                | Paseo                                                                              | Conductor                            |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------ |
| 许可证                         | 开源（Apache-2.0）                                                                 | 闭源                                 |
| 需要账号                       | 否                                                                                 | 是                                   |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（仅 macOS）                       |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | Pro 套餐下即将推出                   |
| CLI                            | 是（应用能做的都能做）                                                             | Pro 套餐下提供 API                   |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | 否（Pro 套餐下提供托管云端工作区）   |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | -                                    |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | 否                                   |
| SSH 访问                       | 是                                                                                 | 否                                   |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | Claude Code、Codex、Cursor、OpenCode |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 是（Git worktree）                   |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | -                                    |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | -                                    |
| 编辑器                         | 是                                                                                 | -                                    |
| 终端                           | 是                                                                                 | 是                                   |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | -                                    |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | GitHub                               |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | -                                    |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | -                                    |
| 定时任务与 heartbeat           | 是                                                                                 | -                                    |
| 套餐用量                       | 是                                                                                 | -                                    |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                   |
| 语音                           | 是（本地语音输入、实时语音）                                                       | -                                    |
| 遥测                           | 无                                                                                 | -                                    |

另请参阅：[Paseo 与 Superset 对比](/alternatives/superset)、[Paseo 与 OpenChamber 对比](/alternatives/openchamber)、[Paseo 与 Happy Coder 对比](/alternatives/happy-coder)。
