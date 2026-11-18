---
title: OpenCode
description: 安装 OpenCode 并在 Paseo 中运行。
nav: OpenCode
---

# OpenCode {#opencode}

使用你现有的 `opencode` 安装、凭据和配置，在 Paseo 中运行 OpenCode。

## 开始使用 {#getting-started}

1. 在 daemon 主机上安装 [OpenCode](https://opencode.ai/)：

   ```bash
   npm install -g opencode-ai
   ```

2. 为 OpenCode 配置模型 Provider，并确认 `opencode` 可以在终端中运行。
3. 在 Paseo 中启动 Agent 时选择 **OpenCode**。

如果你使用 OpenCode v2，请安装 2.0.10 或更高版本。Paseo 会拒绝更早的 v2 版本。

如果 `opencode` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)。

## 模式 {#modes}

Paseo 将 OpenCode 的 Agent 显示为模式。

| 模式  | 效果                                |
| ----- | ----------------------------------- |
| Build | 允许编辑文件和执行工具。            |
| Plan  | 只读规划。OpenCode 会避免编辑文件。 |

你在 OpenCode 中定义的主 Agent 也会出现在同一个列表中。

## 另请参阅 {#see-also}

- GitHub 上的[使用现有的 OpenCode v2 服务器](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md#opencode-with-an-existing-v2-server)：让 Paseo 使用已经在运行的 OpenCode 服务器。
- [Provider 选项](/docs/sdk/provider-options#opencode)：为通过 SDK 创建的 Agent 设置 OpenCode 权限规则。
