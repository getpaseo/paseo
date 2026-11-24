---
title: fx
description: 为 Paseo 安装并添加 fx。
nav: fx
---

# fx {#fx}

Paseo 通过你已安装的 `fx` CLI 提供的 Agent Client Protocol（`fx acp`）运行 Vercel Labs 的编程 Agent fx。它使用你现有的 fx 凭据和设置。

## 开始使用 {#getting-started}

启动 Agent 前，请先在 Paseo 设置中添加 fx。

1. 在 daemon 主机上[安装 fx](https://fx.sh/docs/getting-started/installation)。
2. [为 fx 连接一个模型提供方](https://fx.sh/docs/getting-started/authentication)，例如运行 `fx login`。
3. 在 Paseo 中打开 **设置 → Hosts → 你的主机 → Providers**，选择 **+ Provider**，找到 **fx**，然后选择 **添加**。

在 fx 拿到凭据之前，Paseo 会显示 fx 给出的登录提示。如果 `fx` 不在 daemon 的 PATH 中，请使用[命令覆盖](/docs/custom-providers#custom-binary)，并在参数中保留 `acp`。

## 模型和权限 {#models-and-permissions}

模型列表来自 fx 中当前启用的模型提供方。运行 `fx provider` 可以更改新 Agent 使用的列表。

在 Paseo 中更改 Agent 的权限模式时，fx 也会更新它保存的权限模式。

fx 支持的功能见 [fx 的 ACP 指南](https://fx.sh/docs/using-fx/acp)。
