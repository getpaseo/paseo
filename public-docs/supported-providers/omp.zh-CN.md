---
title: Oh My Pi
description: 为 Paseo 安装并启用 Oh My Pi。
nav: Oh My Pi
---

# Oh My Pi {#oh-my-pi}

Paseo 通过你已安装的 `omp` CLI 运行 Oh My Pi（OMP）。它使用你现有的凭据和设置。

## 开始使用 {#getting-started}

Oh My Pi 内置于 Paseo，默认关闭。

1. 在 daemon 主机上安装 [Oh My Pi](https://github.com/can1357/oh-my-pi)，并确认 `omp` 可以在终端中运行。
2. 在 Paseo 中打开 **设置 → 主机 → Providers**，然后启用 **Oh My Pi**。
3. 启动 Agent 时选择 **Oh My Pi**。

如果 `omp` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)。你也可以在 `~/.paseo/config.json` 的 `agents.providers.omp` 下启用 `omp`。如需运行带有独立设置的第二个 OMP 配置，请参见 GitHub 上的 [OMP profiles](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md#omp-profiles-and-pi-compatible-forks)。

## 权限模式 {#permission-modes}

**Full Access** 是默认模式。

| 模式           | 效果                                 |
| -------------- | ------------------------------------ |
| Full Access    | 工具不经询问直接运行。               |
| Write Approval | 读取不经询问直接运行，写入需要审批。 |
| Always Ask     | 写入文件或运行命令的工具需要审批。   |

## 工具、子 Agent 和会话 {#tools-subagents-and-sessions}

- Oh My Pi 的 Agent 可以使用 Paseo 的工具，例如创建其他 Agent 并向其发送消息的工具。
- Oh My Pi 启动的子 Agent 会在 Paseo 中显示为子 Agent。
- Paseo 可以导入你在终端中启动的会话，会话从 `~/.omp/agent/sessions` 读取。
