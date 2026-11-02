---
title: 相关项目
description: 与 Paseo 相关、由社区构建的项目。
nav: 相关项目
---

# 相关项目 {#related-projects}

这些项目与 Paseo 相关，由社区构建。

## 插件 {#plugins}

在[插件市场](/plugins)浏览经过审核的社区插件。想分享你自己的插件，请按照[发布插件](/docs/plugins/publishing)准备软件包并提交。插件不在沙箱中运行；安装前请阅读它的介绍页和源码。

## 工具与集成 {#tools-and-integrations}

| 项目                                                                                         | 作用                                                                                         |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| [Paseo for VS Code](https://marketplace.visualstudio.com/items?itemName=hinnes.paseo-vscode) | 在 VS Code 中打开对应的 Paseo 项目或 worktree，并添加 Agent 聊天、文件提及和编辑器链接。     |
| [VS Code Web plugin](https://github.com/itsjustanks/paseo-plugin-vscode-web)                 | 通过 VS Code 隧道在 `vscode.dev` 中打开正在运行的 Paseo worktree，包括无界面主机上的工作区。 |
| [Paseo Icon](https://github.com/gpambrozio/paseo-menubar)                                    | 在 macOS 菜单栏中显示各个 Paseo 主机上的工作区状态，一键打开工作区。                         |
| [Paseo Cross-Daemon Comms](https://github.com/xpufx/paseo-cross-daemon-comms)                | 让 Agent 通过 MCP 服务器与另一个 Paseo daemon 上的 Agent 通信。                              |
| [Paseo Antigravity ACP](https://github.com/tiezbro/paseo-agy-acp)                            | 通过 ACP 把 Google Antigravity CLI 接入 Paseo，并处理 Paseo 特有的上下文、权限和并发。       |
| [Desvio](https://github.com/cleiter/desvio)                                                  | 基于一组分支重建个人 fork，用 Agent 解决新冲突，用 Git rerere 重放已知的解决方案。           |

## 托管与基础设施 {#hosting-and-infrastructure}

| 项目                                                                        | 作用                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Paseo Self-hosted](https://github.com/blockfeed/paseo-selfhosted)          | 把 Paseo 网页界面和本地 daemon 打包为 Docker 部署。                                                                                                         |
| [Devbox Fleet](https://github.com/omrihaviv/devbox-fleet)                   | 为每位开发者创建并维护带有 Paseo、编程 Agent 和 Tailscale 访问的 GCP 开发机。                                                                               |
| [Paseo Vercel Sandbox](https://github.com/vercel-labs/paseo-vercel-sandbox) | 创建持久化的 Vercel Sandbox，在其中运行 Paseo daemon，并通过 Vercel AI Gateway 使用 Codex、Claude Code、OpenCode 或 Pi。可将每个沙箱配对为远程 Paseo 主机。 |
