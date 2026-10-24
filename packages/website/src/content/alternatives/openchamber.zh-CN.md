---
title: 支持多 Provider 编排的 OpenChamber 替代品
description: Paseo 是一个 OpenChamber 替代品，适合需要多个 Agent harness、应用插件以及 Apache-2.0 代码库的开发者。
nav: OpenChamber
order: 52
---

# Paseo 与 OpenChamber 对比

OpenChamber 是一个以 MIT 许可发布、围绕 OpenCode 构建的工作区，提供桌面端、Web、VS Code、服务端以及基于 Capacitor 的移动客户端。

Paseo 可以从桌面端、移动端、Web 和 CLI 编排多种编码 Agent harness。它以 Apache-2.0 许可开源。

![Paseo 桌面端和移动端应用](/hero-mockup.png)

## 主要区别 {#the-main-difference}

OpenChamber 围绕 OpenCode 构建 Agent 工作流。Paseo 在运行 OpenCode 的同时，还运行 Claude Code、Codex、Pi、ACP Agent 和自定义 Provider。

OpenChamber 用 Capacitor 把它的 Web 界面打包到 iOS 和 Android 上。界面运行在 WKWebView 或 Android WebView 中，并带有通知、安全存储、二维码配对和小组件等原生集成。Paseo 的移动客户端使用 React Native 构建，并通过 App Store 和 Google Play 发布。

## 架构 {#architecture}

两者都可以在你的工作站或其他机器上运行服务端，并从桌面端、Web 和移动客户端连接。

Paseo 的 daemon 通过每个 Provider 自己的原生 harness 或通过 ACP 启动它。OpenChamber 管理一个 OpenCode 服务端，并围绕 OpenCode 会话构建 Agent 工作流。

## Provider {#providers}

OpenChamber 使用 OpenCode 作为 Agent 运行时。OpenCode 可以连接许多模型提供商，OpenChamber 还为 Claude 等订阅提供集成。

Paseo 在 Agent harness 层面支持多 Provider。它原生支持 Claude Code、Codex、OpenCode、Pi、Antigravity 和 Muse Code，并通过 ACP 目录支持另外 30 多个 Agent，以及任意自定义的 CLI Agent。查看[所有支持的 Provider](/agents)。

## 应用插件 {#application-plugins}

[Paseo 插件](/docs/plugins)用于扩展 Paseo 本身。它们可以添加服务端行为和原生客户端组件，例如工作区面板、侧边栏项、Composer 附件、主题和 Command Center 条目，并在桌面端、浏览器、iOS 和 Android 上运行。

OpenChamber 没有公开文档化的应用扩展 API，无法同时添加服务端行为和原生客户端组件。

## 工作区与审查 {#workspaces-and-review}

两者都支持隔离的 Git worktree、终端、diff 审查、浏览器预览、GitHub 工作流、定时任务和远程机器。

OpenChamber 另外提供多次运行对比、Fusion 以及引导式的变更讲解。Paseo 另外提供拆分窗格和标签页、原生的 Files 和 Changes 浏览器，以及在所有客户端中可用的完整拉取请求工作流。

## 自动化 {#automation}

Paseo 通过 CLI、TypeScript SDK 和 MCP 服务器提供工作区和 Agent 操作。这些接口可以创建工作区、启动 Agent、跟踪进度、发送消息和管理定时任务。

OpenChamber 的 CLI 用于运行和管理它的服务端、远程访问和更新。它的 Agent Control Tool 让 OpenCode Agent 可以创建和继续会话、创建 worktree 以及管理定时任务。

## 移动端与语音 {#mobile-and-voice}

两者都提供 iOS 和 Android 客户端，并支持语音输入和语音回复。Paseo 的移动应用就是完整的应用，在 iOS 和 Android 上原生运行，功能与桌面端完全一致。OpenChamber 用 Capacitor 打包它的 Web 界面，并在 WebView 周围添加原生集成。

## 对比 {#comparison}

|                                | Paseo                                                                              | OpenChamber                                   |
| ------------------------------ | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| 许可证                         | 开源（Apache-2.0）                                                                 | 开源（MIT）                                   |
| 需要账号                       | 否                                                                                 | -                                             |
| 桌面应用                       | 是（一键安装，内置 daemon）                                                        | 是（macOS、Linux、Windows）                   |
| 移动应用                       | 是（原生，与桌面端功能一致）                                                       | 是（Capacitor WebView）                       |
| CLI                            | 是（应用能做的都能做）                                                             | 是（运行和管理服务端）                        |
| 远程机器                       | 是（daemon 可以安装在任何地方）                                                    | 是（服务端运行在另一台机器上）                |
| 内置中继                       | 是（需手动开启，端到端加密，无需账号）                                             | -                                             |
| 直接网络访问                   | 是（局域网、Tailscale、VPN）                                                       | -                                             |
| SSH 访问                       | 是                                                                                 | -                                             |
| Provider                       | Claude Code、Codex、OpenCode、Pi、Antigravity、Muse Code，另有 30 多个             | OpenCode                                      |
| 并行 Agent                     | 是（隔离的 worktree，可跨机器）                                                    | 是（Git worktree、多次运行对比）              |
| 终端 Agent                     | 是（在终端中运行任意 Agent，完成时收到通知）                                       | -                                             |
| Agent 编排                     | 是（Agent 可以创建 worktree 并启动其他 Agent，可跨 Provider）                      | 是（Agent Control Tool，仅限 OpenCode Agent） |
| 编辑器                         | 是                                                                                 | -                                             |
| 终端                           | 是                                                                                 | 是                                            |
| Diff 审查                      | 是（评论会发送给 Agent）                                                           | 是                                            |
| 应用内拉取请求                 | GitHub、GitLab、Gitea、Forgejo、Codeberg                                           | GitHub（issue、PR、检查、审查、合并）         |
| 应用内浏览器                   | 是（元素选择器、Agent 浏览器工具）                                                 | 是（预览）                                    |
| 每个 worktree 的开发服务器 URL | 是（`web--fix-auth--my-app.localhost`）                                            | 预览和端口检测                                |
| 定时任务与 heartbeat           | 是                                                                                 | 是（定时任务）                                |
| 套餐用量                       | 是                                                                                 | -                                             |
| 插件                           | 是（新界面、面板、Agent hook 和 Provider，同一个插件可在桌面端、Web 和移动端运行） | 否                                            |
| 语音                           | 是（本地语音输入、实时语音）                                                       | 语音输入和语音回复                            |
| 遥测                           | 无                                                                                 | -                                             |

另请参阅：[Paseo 与 Conductor 对比](/alternatives/conductor)、[Paseo 与 Superset 对比](/alternatives/superset)、[Paseo 与 Happy Coder 对比](/alternatives/happy-coder)。
