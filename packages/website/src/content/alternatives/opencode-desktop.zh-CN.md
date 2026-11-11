---
title: 支持原生移动端和多 Provider 编排的 OpenCode Desktop 替代品
description: Paseo 是一个 OpenCode Desktop 替代品，适合需要原生移动应用、自托管 daemon，并希望把 OpenCode 与 Claude Code、Codex、Copilot 等一起使用的开发者。
nav: OpenCode Desktop
order: 56
---

# Paseo 与 OpenCode Desktop 对比

OpenCode Desktop 是 OpenCode 的桌面应用。它目前以 beta 版本提供，支持 macOS、Windows 和 Linux。

Paseo 是一个开源的 Agent 式开发环境。你可以在各自独立的 worktree 中并行运行多个 Agent，编辑文件，审查 diff 和拉取请求，并用终端和内置的桌面浏览器测试你的应用。它以 Apache-2.0 许可提供桌面端、移动端、Web 和 CLI。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

OpenCode 通过 OpenCode Agent 运行时连接许多模型提供商。Paseo 在运行 OpenCode 的同时，还运行独立的 Claude Code、Codex、Pi、ACP 以及自定义 Agent harness。

OpenCode 提供终端、IDE、Web 以及 beta 版的桌面界面。Paseo 另外提供原生的 iOS 和 Android 客户端、托管的 worktree 和服务、拉取请求工作流以及应用插件。

## 架构 {#architecture}

Paseo 在你的机器上运行一个 daemon。桌面端、Web、移动端和 CLI 客户端通过 websocket 连接到它。daemon 使用你已安装的 CLI 和凭据，以本地进程的方式启动 OpenCode 和其他 Provider。

OpenCode Desktop 是 OpenCode 的桌面应用。OpenCode 提供终端界面、桌面应用、IDE 扩展、Web 界面和各种集成。

## Provider {#providers}

OpenCode 是一个支持多模型的编码 Agent。它可以通过自己的 Provider 系统连接许多 LLM 提供商，包括 OpenCode Zen、本地模型和 API 提供商。

Paseo 在 Agent harness 层面支持多 Provider。它原生支持 OpenCode、Claude Code、Codex、Pi、Antigravity 和 Muse Code，并通过应用内目录支持另外 30 多个 Agent，包括 GitHub Copilot、Cursor、Gemini CLI 和 Amp。Paseo 支持 [Agent Client Protocol](https://agentclientprotocol.com)，因此任何 ACP Agent 都可以使用。自定义 Provider 可以运行任何 CLI Agent。查看[所有支持的 Provider](/agents)。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

OpenCode Desktop 没有公开文档化的应用扩展 API，无法同时添加服务端行为和原生客户端组件。

## 桌面平台 {#desktop-platforms}

Paseo 支持 macOS、Linux 和 Windows。OpenCode 为同样的平台提供 beta 版桌面构建。

## 移动端 {#mobile}

移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。

OpenCode Desktop 是一个桌面应用。OpenCode 也有 Web 和分享链接工作流，但没有原生的移动应用。

## 窗格 {#panes}

Paseo 应用支持拆分窗格和标签页（⌘D 垂直拆分，⌘⇧D 水平拆分）。窗格可以是 Agent、终端、diff 查看器，以及用于测试运行中服务的浏览器。

OpenCode 提供终端、IDE 和桌面界面。它的核心工作流围绕 OpenCode 会话展开。

## GitHub {#github}

Paseo 应用可以完成提交、推送、创建 PR、关注检查和审查，以及合并。

OpenCode 提供 GitHub 和 GitLab 集成，OpenCode 会话可以通过它的 Agent 工作流修改和审查代码。

## CLI 与自动化 {#cli-and-automation}

OpenCode 有自己的终端界面、CLI、IDE 扩展、GitHub 和 GitLab 集成以及分享链接。

Paseo 的 CLI 控制的是与应用相同的 daemon：

```bash
paseo run --provider opencode "implement OAuth"
paseo run --provider claude --worktree refactor-auth "refactor auth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` 连接到远程 daemon。`paseo schedule` 按 cron 运行 Agent。MCP 服务器让其他 Agent 能够创建 worktree、启动 Agent、打开终端和发送提示词。

## Worktree 与服务 {#worktrees-and-services}

Paseo 在各自的 Git worktree 中运行每个 Agent。每个 worktree 都有独立的开发服务器 URL，例如 `web--fix-auth--my-app.localhost`，因此并行的 Agent 不会争抢端口。

OpenCode 支持在同一个项目上进行多会话工作。如果你希望为 OpenCode 会话提供 worktree 隔离，Paseo 可以在 Paseo 工作区中启动 OpenCode 来实现这一点。

## 隐私与源代码 {#privacy-and-source}

两者都是开源的。

Paseo 采用 Apache-2.0 许可，通过你掌控的 daemon 运行你的 Agent。OpenCode 是开源的，并表示默认不会存储你的代码或上下文数据。你创建的 OpenCode 分享链接是公开的。

## 语音 {#voice}

Paseo 支持语音输入和实时语音模式。语音转文字和文字转语音都可以在你的设备上本地运行。

## 对比 {#comparison}

|                                | Paseo                                                                              | OpenCode Desktop                   |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------- |
| 许可证                         | 开源（Apache-2.0）                                                                 | 开源（MIT）                        |
| 需要账号                       | 否                                                                                 | -                                  |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（beta，macOS、Linux、Windows）  |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | 否                                 |
| CLI                            | 是（应用能做的都能做）                                                             | 是（OpenCode CLI）                 |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | OpenCode 服务端                    |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | -                                  |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | -                                  |
| SSH 访问                       | 是                                                                                 | -                                  |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | OpenCode（支持许多模型提供商）     |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 多个会话，没有内置的 worktree 管理 |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | -                                  |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | OpenCode 内的 MCP 支持             |
| 编辑器                         | 是                                                                                 | -                                  |
| 终端                           | 是                                                                                 | OpenCode 终端工作流                |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | -                                  |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | GitHub、GitLab 集成                |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 否                                 |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | 否                                 |
| 定时任务与 heartbeat           | 是                                                                                 | -                                  |
| 套餐用量                       | 是                                                                                 | -                                  |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                 |
| 语音                           | 是（本地语音输入、实时语音）                                                       | 否                                 |
| 遥测                           | 无                                                                                 | -                                  |

另请参阅：[Paseo 与 Codex App 对比](/alternatives/codex-app)、[Paseo 与 Claude Desktop 对比](/alternatives/claude-desktop)、[Paseo 与 OpenChamber 对比](/alternatives/openchamber)。
