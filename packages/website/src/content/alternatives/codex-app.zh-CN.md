---
title: 开源的 Codex App 替代品，支持原生移动端和多 Provider
description: Paseo 是一个开源的 Codex 替代品，运行在你自己的机器上，不需要 Paseo 账号，没有遥测，也不依赖云服务。
nav: Codex App
order: 54
---

# Paseo 与 Codex App 对比

OpenAI 通过 ChatGPT 桌面应用在 macOS、Windows 和 Linux 上提供 Codex，支持本地、worktree、云端和远程工作流。

Paseo 是一个开源的 Agent 式开发环境。你可以在各自独立的 worktree 中并行运行多个 Agent，编辑文件，审查 diff 和拉取请求，并用终端和内置的桌面浏览器测试你的应用。它以 Apache-2.0 许可提供桌面端、移动端、Web 和 CLI。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

OpenAI 通过 ChatGPT 桌面和移动应用提供 Codex。使用这些产品需要 OpenAI 账号，云端工作运行在 OpenAI 托管的基础设施上。

Paseo 在你掌控的机器上运行你已安装的 Codex CLI。它不需要 Paseo 账号，不收集遥测数据，也不依赖 Paseo 的云服务。你可以从桌面端、移动端、Web 或 CLI 直接连接，也可以使用可选的端到端加密中继。

Paseo 不会上传或存储你的代码。中继无法读取你的代码、消息或 Agent 输出。你可以自托管 daemon、Web 客户端和中继，并用同一个控制平面管理 Codex、Claude Code、OpenCode、Pi、ACP Agent 和自定义 Provider。

## 架构 {#architecture}

Paseo 在你的笔记本、工作站、虚拟机、家庭实验室或云主机上运行一个独立的 daemon。daemon 使用你已安装的 Codex CLI 及其现有的凭据和配置来启动它。客户端直接连接，或通过可选的端到端加密中继连接。

OpenAI 通过其 ChatGPT 产品提供本地、worktree、远程和云端的 Codex 工作流。本地和远程工作使用一台已连接的主机，云端工作则运行在 OpenAI 托管的基础设施上。

## Provider {#providers}

Codex App 运行 Codex。

Paseo 同样运行 Codex，还原生支持 Claude Code、OpenCode、Pi、Antigravity 和 Muse Code，并通过应用内目录支持另外 30 多个 Agent，包括 GitHub Copilot、Cursor、Gemini CLI 和 Amp。Paseo 支持 [Agent Client Protocol](https://agentclientprotocol.com)，因此任何 ACP Agent 都可以使用。自定义 Provider 可以运行任何 CLI Agent。查看[所有支持的 Provider](/agents)。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

Codex 支持技能、MCP 服务器和其他 Agent 扩展。OpenAI 没有公开文档化的扩展 API，无法为 Codex 应用本身添加服务端行为和原生界面组件。

## 桌面平台 {#desktop-platforms}

OpenAI 的桌面应用和 Paseo 都支持 macOS、Windows 和 Linux。

## 移动端 {#mobile}

移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。

ChatGPT Remote 可以通过一台已连接的桌面主机，在 iOS 和 Android 上启动和继续 Codex 对话、批准操作并审查输出。

## Worktree 与本地设置 {#worktrees-and-local-setup}

两者都支持使用 Git worktree 进行并行工作。

Codex App 在 `$CODEX_HOME/worktrees` 下创建由 Codex 管理的 worktree，并通过 `.codex` 配置支持本地环境设置脚本和项目操作。

Paseo 在 `$PASEO_HOME/worktrees` 下创建 worktree，运行 `paseo.json` 中的设置和清理钩子，并为每个 worktree 提供独立的开发服务器 URL，例如 `web--fix-auth--my-app.localhost`，这样并行的服务就不会争抢端口。

## GitHub 与审查 {#github-and-review}

两者都支持在应用中审查 diff、提交、推送和创建拉取请求。

Paseo 还会在应用中显示 PR 的检查和审查，并通过 CLI 和 MCP 服务器提供同样的工作流。

## CLI 与自动化 {#cli-and-automation}

Codex 有自己的 CLI、IDE 扩展、Web 应用、自动化和 SDK。

Paseo 的 CLI 控制的是与应用相同的 daemon：

```bash
paseo run --provider codex "implement OAuth"
paseo run --provider claude --worktree refactor-auth "refactor auth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` 连接到远程 daemon。`paseo schedule` 按 cron 运行 Agent。MCP 服务器让其他 Agent 能够创建 worktree、启动 Agent、打开终端和发送提示词。

## 语音 {#voice}

Codex App 支持语音输入。

Paseo 支持语音输入和实时语音模式。语音转文字和文字转语音都可以在你的设备上本地运行。

## 对比 {#comparison}

|                                | Paseo                                                                              | Codex App                             |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------- |
| 许可证                         | 开源（Apache-2.0）                                                                 | Codex CLI 开源；应用为专有软件        |
| 需要账号                       | 否                                                                                 | OpenAI 账号                           |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（macOS、Linux、Windows）           |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | ChatGPT 应用（Remote）                |
| CLI                            | 是（应用能做的都能做）                                                             | 是（Codex CLI）                       |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | 是（已连接的主机、OpenAI 托管的云端） |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | OpenAI Remote                         |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | -                                     |
| SSH 访问                       | 是                                                                                 | -                                     |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | Codex                                 |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 是（Git worktree）                    |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | -                                     |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | -                                     |
| 编辑器                         | 是                                                                                 | -                                     |
| 终端                           | 是                                                                                 | 是                                    |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | 是                                    |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | 提交、推送、PR                        |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 是                                    |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | 否                                    |
| 定时任务与 heartbeat           | 是                                                                                 | -                                     |
| 套餐用量                       | 是                                                                                 | -                                     |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                    |
| 语音                           | 是（本地语音输入、实时语音）                                                       | 语音输入                              |
| 遥测                           | 无                                                                                 | -                                     |

另请参阅：[Paseo 与 Claude Desktop 对比](/alternatives/claude-desktop)、[Paseo 与 OpenCode Desktop 对比](/alternatives/opencode-desktop)、[所有支持的 Provider](/agents)。
