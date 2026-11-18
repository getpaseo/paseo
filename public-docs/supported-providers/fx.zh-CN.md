---
title: fx
description: 为 Paseo 安装和配置 fx。
nav: fx
---

# fx {#fx}

使用你现有的 fx 安装和凭据，在 Paseo 中运行 Vercel Labs 的编程 Agent fx。

## 开始使用 {#getting-started}

1. 在 daemon 主机上[安装 fx](https://fx.sh/docs/getting-started/installation)。
2. [为 fx 连接一个模型提供方](https://fx.sh/docs/getting-started/authentication)，例如运行 `fx login`。
3. 在 Paseo 中打开 **设置 → Hosts → 你的主机 → Providers**，在目录里找到 **fx** 并选择 **添加**。

Paseo 会启动 `fx acp`，并使用你的 fx 凭据和设置。在 fx 拿到凭据之前，该 Provider 会显示 fx 给出的登录提示。

如果 `fx` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers)，并在参数中保留 `acp`。

## 模型和权限 {#models-and-permissions}

模型列表来自 fx 中当前启用的模型提供方。运行 `fx provider` 可以更改新 Agent 使用的列表。

在 Paseo 中更改 Agent 的权限模式，也会更改 fx 保存的权限模式。

fx 支持的功能见 [fx 的 ACP 指南](https://fx.sh/docs/using-fx/acp)。
