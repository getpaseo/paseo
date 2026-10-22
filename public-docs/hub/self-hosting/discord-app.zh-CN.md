---
title: 为 Hub 配置 Discord
description: 创建 Hub 使用的 Discord 应用并连接服务器。
nav: Discord 应用
---

# 为 Hub 配置 Discord {#discord-for-hub}

Hub 通过 gateway 主动连接 Discord。Discord 不会向 Hub 发送事件 webhook，因此机器人不需要公开的入站端点。

打开 **Apps → Discord**。Hub 会给出重定向 URL，以及创建应用、启用机器人、复制 Application ID、Client Secret 和 Bot token 的具体步骤。

在 **Bot → Privileged Gateway Intents** 下启用 **Message Content Intent**。否则机器人收到的消息是空的，任何触发器都无法匹配。不需要 Server Members Intent。

把凭据粘贴到 Hub 中，选择 **Verify and save**。然后选择 **Add to a Discord server** 并授权服务器。请从 Hub 发起授权，这样服务器会绑定到当前的 Hub 组织。

一个 Discord 应用和一条 gateway 连接服务于连接到此 Hub 的所有组织和服务器。请保持 Hub 进程运行；进程停止期间到达的事件会丢失。

接下来编写一个 [Discord 触发器](/docs/hub/triggers/discord)。

## 通过环境变量配置 {#configure-from-environment}

把应用密钥保存在 Hub 之外的部署可以设置：

```dotenv
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

`DISCORD_CLIENT_ID` 是 **General Information** 下显示的 Application ID。环境变量配置优先于已保存的 Discord 应用，并在 **Apps** 下显示为 **Managed by environment**。
