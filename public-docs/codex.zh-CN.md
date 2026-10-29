---
title: Codex
description: 使用官方 Codex CLI 和你现有的 OpenAI 账号在 Paseo 中运行 Codex。
nav: Codex
---

# Codex {#codex}

Paseo 通过官方的 `codex` CLI 及其 app-server 接口运行 Codex。

## 在 Paseo 中使用 Codex 需要额外付费吗？ {#does-codex-cost-extra-in-paseo}

不需要。Paseo 不会为 Codex 额外收费。用 ChatGPT 登录 Codex CLI，即可使用 ChatGPT 套餐包含的额度；或者用 API key 登录，用量通过你的 OpenAI Platform 账号计费。

你套餐中常规的 Codex 限额和 OpenAI 的标准 API 价格仍然适用。

## 开始使用 {#getting-started}

在运行 Paseo 的机器上安装 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)：

```bash
npm install -g @openai/codex
```

用 ChatGPT 登录以使用订阅额度：

```bash
codex login
```

或者用 API key 登录，用量通过你的 OpenAI Platform 账号计费：

```bash
# macOS or Linux
printenv OPENAI_API_KEY | codex login --with-api-key
```

```powershell
# Windows PowerShell
$env:OPENAI_API_KEY | codex login --with-api-key
```

然后确认 CLI 能够启动：

```bash
codex
```

你启动 Codex Agent 时，Paseo 会使用这份安装及其现有的认证。

## Paseo 中找不到 Codex {#codex-is-missing-in-paseo}

ChatGPT 桌面应用和 Codex CLI 是分开安装的。安装桌面应用并不会让 Paseo 找到 `codex` 命令。

检查 CLI 是否在你的 `PATH` 中：

```bash
# macOS or Linux
which -a codex

# Windows
where.exe codex
```

如果找不到该命令：

1. 安装 [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)。
2. 使用上面的命令通过 ChatGPT 或 API key 登录。参见 [Codex 认证](https://learn.chatgpt.com/docs/auth)。
3. 如果安装 CLI 时 Paseo 的 daemon 已在运行，请重启 Paseo。
4. 在 Paseo 中打开 **设置 → Providers → Codex** 并选择 **刷新**。

当 Paseo 能找到并启动 `codex` 命令后，这个 Provider 就会变为可用。

## 在 Paseo 终端中使用 Codex {#use-codex-in-the-paseo-terminal}

Codex 在 Paseo 终端里同样可用。在工作区中打开终端并运行 `codex`，即可获得标准的 CLI 体验，同时保留对工作区、git 改动和其他 Paseo 工具的访问。

## 另请参阅 {#see-also}

- [支持的 Provider](/docs/supported-providers)：可以与 Codex 一起运行的其他 Agent。
- [自定义 Provider](/docs/custom-providers)：自定义二进制、第三方端点或多个 Codex 配置。
- [Paseo 与 Codex app 对比](/alternatives/codex-app)：功能比较。
