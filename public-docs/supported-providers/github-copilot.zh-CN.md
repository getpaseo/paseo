---
title: GitHub Copilot
description: 安装 GitHub Copilot CLI 并在 Paseo 中运行。
nav: GitHub Copilot
---

# GitHub Copilot {#github-copilot}

使用你现有的 `copilot` CLI 和 GitHub 账号，在 Paseo 中运行 GitHub Copilot。

## 开始使用 {#getting-started}

1. 在 daemon 主机上安装 [GitHub Copilot CLI](https://github.com/features/copilot/cli/)。
2. 在终端中运行 `copilot` 并登录 GitHub。
3. 在 Paseo 中启动 Agent 时选择 **Copilot**。

Paseo 会启动 `copilot --acp`，并使用 CLI 已有的登录状态。如果 `copilot` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)，并在参数中保留 `--acp`。

## 模式 {#modes}

**Agent** 是默认模式。

| 模式      | 效果                                        |
| --------- | ------------------------------------------- |
| Agent     | 用于对话式工作的默认模式。                  |
| Plan      | Copilot 创建多步骤计划并执行。              |
| Allow All | Copilot 自行批准所有工具、路径和 URL 请求。 |
