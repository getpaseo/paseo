---
title: 在 Hub 中使用 Slack
description: 通过 Socket Mode 连接 Slack，或从公开的 Hub 使用 webhook。
nav: Slack 应用
---

# 在 Hub 中使用 Slack {#slack-for-hub}

Slack 可以通过两种方式连接 Hub：

| 传输方式    | 需要公开 HTTPS | 适用场景                 |
| ----------- | -------------- | ------------------------ |
| Socket Mode | 否             | 本地、个人和单进程的 Hub |
| Webhooks    | 是             | 公开服务器部署           |

浏览器设置中默认使用 Socket Mode。两种传输方式产生相同的 `slack.mention` 触发器和线程回复。

## 设置 Socket Mode {#set-up-socket-mode}

在 Hub 中打开 **Apps → Slack**，保持选中 **Socket Mode**。Hub 会给出 Slack manifest 以及具体步骤：

1. 用 manifest 创建 Slack 应用。
2. 生成带有 `connections:write` 的 App-level token。
3. 安装应用并复制它的 Bot User OAuth Token。

把两个 token 粘贴到 Hub 中，然后选择 **Connect Slack**。Hub 会验证安装，为当前组织保存它，并打开出站的 Socket Mode 连接。

把机器人邀请到每个它需要关注的频道：

```text
/invite @Paseo
```

现在编写一个 [Slack 触发器](/docs/hub/triggers/slack)。

Socket Mode 在 Hub 进程中保持一条活动连接。使用这种传输方式时，请只运行一个 Hub 进程并保持它运行；它停止期间到达的事件会丢失。

## 使用 webhook {#use-webhooks}

当 Slack 应该把事件发送到一个稳定的公开 Hub 时，选择 **Webhooks**。设置之前，Hub 必须已经在其公开 HTTPS 地址上打开，这样生成的重定向 URL 和请求 URL 才正确。

Apps 指南会给出一份 webhook manifest，并要求填写 App ID、Client ID、Client Secret 和 Signing Secret。保存后会跳转到 Slack，以便你把应用安装到某个 Slack 工作区。

Slack 调用：

| Provider 设置 | Hub URL                                               |
| ------------- | ----------------------------------------------------- |
| Redirect URL  | `<PASEO_HUB_APP_URL>/api/integrations/slack/callback` |
| Request URL   | `<PASEO_HUB_APP_URL>/api/integrations/slack/events`   |

请从 Hub 发起安装。只从 Slack 发起的安装不会绑定到任何 Hub 组织。

## 通过环境变量配置 {#configure-from-environment}

把应用密钥保存在 Hub 之外的部署可以使用一套完整的传输配置。

Socket Mode：

```dotenv
SLACK_TRANSPORT=socket
SLACK_APP_ID=A01234567
SLACK_APP_TOKEN=xapp-...
```

Bot User OAuth Token 仍然附加在每个已保存的 Slack 工作区连接上；它不属于 Socket Mode 的环境变量配置。

Webhooks：

```dotenv
SLACK_TRANSPORT=webhook
SLACK_APP_ID=A01234567
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

环境变量配置优先于已保存的 Slack 应用，并在 **Apps** 下显示为 **Managed by environment**。
