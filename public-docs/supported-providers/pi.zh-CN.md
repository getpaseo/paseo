---
title: Pi
description: 安装 Pi 并在 Paseo 中运行。
nav: Pi
---

# Pi {#pi}

使用你现有的 `pi` 安装、凭据和设置，在 Paseo 中运行 Pi。

## 开始使用 {#getting-started}

1. 在 daemon 主机上安装 [Pi](https://pi.dev)。
2. 为 Pi 配置模型 Provider，并确认 `pi` 可以在终端中运行。
3. 在 Paseo 中启动 Agent 时选择 **Pi**。

daemon 能够启动 `pi` 时，Pi 就会出现在 Paseo 中。如果 `pi` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)。

## 模式和会话 {#modes-and-sessions}

- Pi 没有权限模式，所以 Paseo 不会为 Pi Agent 显示模式选择器。
- Paseo 可以导入你在终端中启动的会话。它从 `~/.pi/agent/sessions` 读取，或者从你在 Pi 中配置的会话目录读取。

## 超时 {#timeouts}

Paseo 等待 Pi 响应控制请求（例如获取模型列表）的时间上限为 60 秒。如果 Pi 在你的主机上需要更长时间，请在 [Provider 选项](/docs/custom-providers#provider-options)中调高 `rpcTimeoutMs`。

## 另请参阅 {#see-also}

- [Oh My Pi](/docs/supported-providers/omp)：独立的 Provider，有自己的权限模式。
- GitHub 上的 [Pi 兼容分支](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md#omp-profiles-and-pi-compatible-forks)：适用于保留 Pi 的 RPC 模式但使用其他命令的 Provider。
