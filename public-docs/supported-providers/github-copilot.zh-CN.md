---
title: GitHub Copilot
description: 安装 GitHub Copilot CLI 并在 Paseo 中运行。
nav: GitHub Copilot
---

# GitHub Copilot {#github-copilot}

Paseo 通过你已安装的 `copilot` CLI 提供的官方 Agent Client Protocol（`copilot --acp`）运行 GitHub Copilot。它使用你的本地 CLI 和现有的 GitHub 登录状态。

## 开始使用 {#getting-started}

GitHub Copilot 内置于 Paseo 且默认启用。

1. 在 daemon 主机上安装 [GitHub Copilot CLI](https://github.com/features/copilot/cli/)。
2. 在终端中运行 `copilot` 并登录 GitHub。
3. 在 Paseo 中启动 Agent 时选择 **Copilot**。

如果 `copilot` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)，并在参数中保留 `--acp`。

## 模式 {#modes}

**Agent** 是默认模式。

| 模式      | 效果                                              |
| --------- | ------------------------------------------------- |
| Agent     | 用于对话式工作的默认模式。                        |
| Plan      | Copilot 创建并运行多步骤计划。                    |
| Allow All | Copilot 无需询问即批准所有工具、路径和 URL 请求。 |
