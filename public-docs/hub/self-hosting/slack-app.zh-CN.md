---
title: 为 Hub 配置 Slack
description: 通过 Socket Mode 或 webhook 将 Slack 连接到自托管 Hub。
nav: Slack 应用
---

# 为 Hub 配置 Slack {#slack-for-hub}

Slack 可以通过两种方式连接到自托管 Hub：

| 传输方式    | 需要公开 HTTPS | 最适合                 |
| ----------- | -------------- | ---------------------- |
| Socket Mode | 否             | 本地、个人或单进程 Hub |
| Webhooks    | 是             | 公开服务器部署         |

浏览器设置默认使用 Socket Mode。两种传输方式均支持 `slack.mention` 触发器、讨论串回复以及[受控 Slack 集成工具](/docs/hub/tools)。

## 配置 Socket Mode {#set-up-socket-mode}

在 Hub 中打开 **Apps → Slack**，保持选中 **Socket Mode**。Hub 会生成 Slack manifest 并引导完成以下步骤：

1. 使用生成的 manifest 创建 Slack 应用。
2. 生成带有 `connections:write` 权限的 App-level token。
3. 安装应用并复制 Bot User OAuth Token。
4. 将两个令牌粘贴到 Hub 中，选择 **Connect Slack**。

Hub 会验证安装、将其保存在 **Integrations** 下，并建立出站 Socket Mode 连接。

将机器人邀请到它要监听或发送消息的每个频道：

```text
/invite @Paseo
```

Socket Mode 在 Hub 进程内维持一条实时连接。请仅运行一个 Hub 进程并保持运行，因为停止期间到达的事件会丢失。

接下来创建一个 [Slack 触发器](/docs/hub/triggers/slack)。

## 使用 webhook {#use-webhooks}

如果让 Slack 将事件发送到公开 Hub，请选择 **Webhooks**。配置前请先通过[公开 HTTPS 地址](/docs/hub/self-hosting#public-addresses)打开 Hub，以确保生成的 manifest 使用正确 URL。

**Apps → Slack** 会提供 webhook manifest，并要求填写 **App ID**、**Client ID**、**Client Secret** 和 **Signing Secret**。保存后会跳转到 Slack 以授权工作区。请始终从 Hub 发起工作区安装，使工作区绑定到当前 Hub 组织。

Slack 会调用这些 Hub URL：

| Provider 设置 | Hub URL                                               |
| ------------- | ----------------------------------------------------- |
| Redirect URL  | `<PASEO_HUB_APP_URL>/api/integrations/slack/callback` |
| Request URL   | `<PASEO_HUB_APP_URL>/api/integrations/slack/events`   |

## 通过环境变量配置 {#configure-from-environment}

在 Hub 之外管理密钥的部署可通过环境变量提供一套完整的传输配置。

Socket Mode：

```dotenv
SLACK_TRANSPORT=socket
SLACK_APP_ID=A01234567
SLACK_APP_TOKEN=xapp-...
```

Bot User OAuth Token 保留在 **Integrations** 下每个已保存的 Slack 工作区上，不属于 Socket Mode 环境变量。

Webhooks：

```dotenv
SLACK_TRANSPORT=webhook
SLACK_APP_ID=A01234567
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

环境变量配置优先于已保存的 Slack 应用，并在 **Apps** 下显示为 **Managed by environment**。
