---
title: Claude Code
description: 使用你现有的 Claude 套餐在 Paseo 中运行 Claude Code。
nav: Claude Code
---

# Claude Code {#claude-code}

Paseo 通过官方的 `claude` CLI 和 Claude Agent SDK 运行 Claude Code。它使用你的本地安装和现有的 Claude 账号。

## 开始使用 {#getting-started}

Claude Code 内置于 Paseo 且默认启用。

1. 在 daemon 主机上安装 [Claude Code CLI](https://code.claude.com/docs/en/setup#install-claude-code)。
2. 在终端中运行 `claude` 并登录。
3. 在 Paseo 中启动 Agent 时选择 **Claude**。

如果 `claude` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)。

如果 Claude 登录过期，请在 Claude Code CLI 中重新登录，然后在 Paseo 中启动新的会话。正在运行的会话会保留启动时的认证状态，重新登录不会更新已有的活跃会话。

## 在 Paseo 中使用 Claude Code 需要额外付费吗？ {#does-claude-code-cost-extra-in-paseo}

不需要。在 Paseo 中使用 Claude Code 计入你正常的 Claude 套餐额度，不需要单独的 Agent SDK 额度。

你仍然需要一个包含 Claude Code 的 Claude 套餐，套餐原有的用量限制同样适用。

## 在 Paseo 终端中使用 Claude Code {#use-claude-code-in-the-paseo-terminal}

Claude Code 也可以在 Paseo 终端中运行。在工作区中打开终端并运行 `claude`，即可获得标准的 CLI 体验。

你可以在 Paseo 的桌面端、网页端或移动端使用终端，同时保留对工作区、git 改动和其他 Paseo 工具的访问。

## 另请参阅 {#see-also}

- [支持的 Provider](/docs/supported-providers)：可以与 Claude Code 一起运行的其他 Agent。
- [自定义 Provider](/docs/custom-providers)：自定义二进制、第三方端点或多个 Claude 配置。
- [Paseo 与 Claude Desktop 对比](/alternatives/claude-desktop)：功能比较。
