---
title: 为 Hub 配置 Discord
description: 创建自托管 Hub 使用的 Discord 应用并连接服务器。
nav: Discord 应用
---

# 为 Hub 配置 Discord {#discord-for-hub}

Hub 通过 Discord gateway 主动向外连接 Discord。Discord 不会向 Hub 发送事件 webhook，因此机器人不需要公开的入站 HTTPS 端点。

## 配置 Discord 应用 {#set-up-the-discord-app}

1. 在 Hub 中打开 **Apps → Discord**。复制重定向 URL，并按步骤创建 Discord 应用和启用机器人。
2. 在 Discord 的 **Bot → Privileged Gateway Intents** 下启用 **Message Content Intent**。不开启时，机器人收到的消息为空，触发器无法匹配。不需要开启 **Server Members Intent**。
3. 将 **Application ID**、**Client Secret** 和 **Bot token** 粘贴回 Hub，选择 **Verify and save**。
4. 从 Hub 选择 **Add to a Discord server** 并授权服务器，将其绑定到 **Integrations** 下的当前 Hub 组织。

一个 Discord 应用和一条 gateway 连接服务于连接到此 Hub 的所有组织和服务器。请保持 Hub 进程运行，因为停止期间到达的事件会丢失。

已连接的 Discord 服务器同时支持 [Discord 触发器](/docs/hub/triggers/discord)和[受控 Discord 集成工具](/docs/hub/tools)。

## 通过环境变量配置 {#configure-from-environment}

在 Hub 之外管理应用密钥的部署可以设置：

```dotenv
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

`DISCORD_CLIENT_ID` 对应 Discord 中 **General Information** 下显示的 **Application ID**。环境变量配置优先于已保存的 Discord 应用，并在 **Apps** 下显示为 **Managed by environment**。
