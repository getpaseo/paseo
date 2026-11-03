---
title: 开源的 Claude Desktop 替代品，支持原生移动端和多 Provider
description: Paseo 是一个开源的 Claude Desktop 替代品，运行在你自己的机器上，不需要 Paseo 账号，没有遥测，也不依赖云服务。
nav: Claude Desktop
order: 55
---

# Paseo 与 Claude Desktop 对比

Claude Desktop 是 Anthropic 推出的应用，在 macOS、Windows 和 Linux 上提供 Claude Chat、Cowork 和 Claude Code。

Paseo 是一个开源的 Agent 式开发环境。你可以在各自独立的 worktree 中并行运行多个 Agent，编辑文件，审查 diff 和拉取请求，并用终端和内置的桌面浏览器测试你的应用。它以 Apache-2.0 许可提供桌面端、移动端、Web 和 CLI。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

Claude Desktop 是 Anthropic 官方的 Claude 界面，需要 Claude 账号。它可以在本地、通过 SSH 或在 Anthropic 的基础设施上运行 Claude Code。

Paseo 是一个开源的控制平面，运行在你掌控的机器上。它不需要 Paseo 账号，不收集遥测数据，也不依赖 Paseo 的云服务。你可以从桌面端、移动端、Web 或 CLI 直接连接；当 daemon 位于防火墙之后时，也可以使用可选的端到端加密中继。

Paseo 不会上传或存储你的代码。中继无法读取你的代码、消息或 Agent 输出。你还可以自托管 daemon、Web 客户端和中继。

## 架构 {#architecture}

Paseo 在你的笔记本、工作站、虚拟机、家庭实验室或云主机上运行一个独立的 daemon。它的客户端直接连接，或通过可选的端到端加密中继连接。daemon 使用你已安装的 Provider 及其现有的凭据、技能、MCP 服务器和项目配置来启动它们。

Claude Desktop 是由 Anthropic 控制的宿主应用。Claude Code 可以在本地运行、通过 SSH 连接，或使用 Anthropic 托管的云端会话。

## Provider {#providers}

Claude Desktop 运行 Claude Code。

Paseo 同样运行 Claude Code，还原生支持 Codex、OpenCode、Pi、Antigravity 和 Muse Code，并通过应用内目录支持另外 30 多个 Agent，包括 GitHub Copilot、Cursor、Gemini CLI 和 Amp。Paseo 支持 [Agent Client Protocol](https://agentclientprotocol.com)，因此任何 ACP Agent 都可以使用。自定义 Provider 可以运行任何 CLI Agent。查看[所有支持的 Provider](/agents)。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

Claude Desktop 没有公开文档化的应用扩展 API，无法同时添加服务端行为和原生客户端组件。

## 桌面平台 {#desktop-platforms}

Claude Desktop 和 Paseo 都支持 macOS、Windows 和 Linux。

## 移动端 {#mobile}

移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。

Claude 有 iOS 和 Android 应用。Dispatch 可以通过一台处于活动状态的 Claude Desktop 主机启动本地的 Claude Code 工作，或在 Anthropic 的基础设施上启动云端会话。

## 窗格 {#panes}

两者都支持围绕 Claude Code 的可视化编码工作流。

Paseo 应用支持拆分窗格和标签页（⌘D 垂直拆分，⌘⇧D 水平拆分）。窗格可以是 Agent、终端、diff 查看器，以及用于测试运行中服务的浏览器。

Claude Desktop 有一个图形化的 Code 标签页，包含会话、集成终端、文件编辑器、可视化 diff 审查、应用实时预览、PR 监控和定时任务。

## GitHub {#github}

Paseo 应用可以完成提交、推送、创建 PR、关注检查和审查，以及合并。

Claude Desktop 可以监控拉取请求的状态，并根据工作流和权限修复失败或在检查通过后合并。

## CLI 与自动化 {#cli-and-automation}

Claude Code 有自己的 CLI、IDE 集成、Web 界面、定时任务和云端会话。

Paseo 的 CLI 控制的是与应用相同的 daemon：

```bash
paseo run --provider claude "implement OAuth"
paseo run --provider codex --worktree refactor-auth "refactor auth"
paseo run --host devbox:6767 "run the test suite"
paseo ls
paseo send <agent-id> "add tests"
paseo schedule create --cron "0 9 * * 1" "audit the codebase"
```

`paseo run --host` 连接到远程 daemon。`paseo schedule` 按 cron 运行 Agent。MCP 服务器让其他 Agent 能够创建 worktree、启动 Agent、打开终端和发送提示词。

## Worktree 与服务 {#worktrees-and-services}

两者都支持并行编码会话，包括 Git worktree。

Paseo 还为每个 worktree 提供独立的开发服务器 URL。两个 Agent 同时运行开发服务器时，会分别得到 `web--fix-auth--my-app.localhost` 和 `web--add-search--my-app.localhost`，而不会发生端口冲突。

## 语音 {#voice}

Paseo 支持语音输入和实时语音模式。语音转文字和文字转语音都可以在你的设备上本地运行。

Claude 在其自己的移动端和应用界面中支持语音。Claude Code 本身可以在 Claude Desktop、终端、IDE、Web 以及移动端 Remote Control 工作流中使用。

## 对比 {#comparison}

|                                | Paseo                                                                              | Claude Desktop                           |
| ------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| 许可证                         | 开源（Apache-2.0）                                                                 | 未以开源形式发布                         |
| 需要账号                       | 否                                                                                 | Claude 账号                              |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（macOS、Linux、Windows）              |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | Claude 应用（Dispatch 和 Cowork）        |
| CLI                            | 是（应用能做的都能做）                                                             | 是（Claude Code CLI）                    |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | 是（SSH 主机、Anthropic 托管的云端会话） |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | Anthropic Remote                         |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | -                                        |
| SSH 访问                       | 是                                                                                 | 是                                       |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | Claude Code                              |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 是（Git worktree）                       |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | -                                        |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | -                                        |
| 编辑器                         | 是                                                                                 | 是（文件编辑器）                         |
| 终端                           | 是                                                                                 | 是                                       |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | 是                                       |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | PR 监控和合并工作流                      |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 是（应用实时预览）                       |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | 否                                       |
| 定时任务与 heartbeat           | 是                                                                                 | 是（定时任务）                           |
| 套餐用量                       | 是                                                                                 | -                                        |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                       |
| 语音                           | 是（本地语音输入、实时语音）                                                       | 是（在 Claude 的移动端和应用界面中）     |
| 遥测                           | 无                                                                                 | -                                        |

另请参阅：[Paseo 与 Codex App 对比](/alternatives/codex-app)、[Paseo 与 OpenCode Desktop 对比](/alternatives/opencode-desktop)、[Paseo 与 Conductor 对比](/alternatives/conductor)。
