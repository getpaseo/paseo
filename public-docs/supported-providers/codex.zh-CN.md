---
title: Codex
description: 使用官方 Codex CLI 和你现有的 OpenAI 账号在 Paseo 中运行 Codex。
nav: Codex
---

# Codex {#codex}

Paseo 通过官方的 `codex` CLI 及其 app-server 接口运行 Codex。它使用你的本地安装和现有的 OpenAI 登录状态。

## 开始使用 {#getting-started}

Codex 内置于 Paseo 且默认启用。

1. 在 daemon 主机上安装 [Codex CLI](https://developers.openai.com/codex/cli)：

   ```bash
   npm install -g @openai/codex
   ```

2. 用 ChatGPT 登录以使用订阅额度：

   ```bash
   codex login
   ```

3. 在 Paseo 中启动 Agent 时选择 **Codex**。

如需通过 OpenAI Platform API key 计费，请在 macOS 或 Linux 上运行 `printenv OPENAI_API_KEY | codex login --with-api-key`。在 Windows PowerShell 上运行 `$env:OPENAI_API_KEY | codex login --with-api-key`。更多登录说明见 [Codex 认证](https://learn.chatgpt.com/docs/auth)。

如果 `codex` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)。

## 在 Paseo 中使用 Codex 需要额外付费吗？ {#does-codex-cost-extra-in-paseo}

不需要。Paseo 不会为 Codex 额外收费。用 ChatGPT 登录可使用 ChatGPT 套餐包含的额度；用 API key 登录则通过你的 OpenAI Platform 账号计费。

你套餐中常规的 Codex 限额和 OpenAI 的标准 API 价格仍然适用。

## Paseo 中找不到 Codex {#codex-is-missing-in-paseo}

ChatGPT 桌面应用和 Codex CLI 是分开安装的。安装桌面应用并不会为 Paseo 添加 `codex` 命令。

确认 `codex` 在你的 `PATH` 中：

```bash
# macOS or Linux
which -a codex

# Windows
where.exe codex
```

如果找不到该命令：

1. 安装 [Codex CLI](https://developers.openai.com/codex/cli)。
2. 使用 `codex login` 或 API key 登录。
3. 如果安装 CLI 时 Paseo 的 daemon 已在运行，请重启 Paseo。
4. 在 Paseo 中打开 **设置 → 主机 → Providers → Codex**，然后选择 **刷新**。

当 Paseo 能找到并启动 `codex` 命令后，Codex 就会变为可用。

## 在 Paseo 终端中使用 Codex {#use-codex-in-the-paseo-terminal}

Codex 也可以在 Paseo 终端中运行。在工作区中打开终端并运行 `codex`，即可获得标准的 CLI 体验。

你可以在 Paseo 的桌面端、网页端或移动端使用终端，同时保留对工作区、git 改动和其他 Paseo 工具的访问。

## 另请参阅 {#see-also}

- [支持的 Provider](/docs/supported-providers)：可以与 Codex 一起运行的其他 Agent。
- [自定义 Provider](/docs/custom-providers)：自定义二进制、第三方端点或多个 Codex 配置。
- [Paseo 与 Codex app 对比](/alternatives/codex-app)：功能比较。
