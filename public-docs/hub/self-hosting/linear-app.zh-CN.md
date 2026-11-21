---
title: 为 Hub 配置 Linear
description: 创建 Linear OAuth 应用并将 Linear 工作区连接到你的自托管 Hub。
nav: Linear 应用
---

# 为 Hub 配置 Linear {#linear-for-hub}

Linear webhook 需要 HTTPS。在配置 Linear 之前，请先通过[公开 HTTPS 地址](/docs/hub/self-hosting#public-addresses)打开自托管 Hub。Linear 工作区管理员必须授权该应用。

## 配置 Linear 应用 {#set-up-the-linear-app}

1. 在 Hub 中打开 **Apps → Linear**。复制 **Redirect URL** 和 **Webhook URL**。
2. 打开 [Linear API applications](https://linear.app/settings/api/applications)，创建 OAuth 应用，并将 **Redirect URL** 添加到 OAuth 设置中。
3. 使用来自 Hub 的 **Webhook URL** 为 **Issue** 和 **Comment** 事件启用 webhook，并复制 webhook 签名密钥。
4. 返回 Hub，粘贴 **Client ID**、**Client Secret** 和 **Webhook signing secret**。
5. 选择 **Save and continue to Linear** 并授权 Linear 工作区。

在 Hub 的 **Integrations** 下确认已连接的工作区。每个已连接的工作区都会获得一个供触发器引用的连接 slug，例如 `acme-linear`。

Linear 会调用这些 Hub URL：

| 设置         | Hub URL                                                |
| ------------ | ------------------------------------------------------ |
| Redirect URL | `<PASEO_HUB_APP_URL>/api/integrations/linear/callback` |
| Webhook URL  | `<PASEO_HUB_APP_URL>/api/integrations/linear/events`   |

Hub 请求 `read` 和 `comments:create` OAuth 权限范围，并以 Linear 应用身份发布回复。接下来使用 [Linear 触发器](/docs/hub/triggers/linear)创建你的第一个触发器。

## 通过环境变量配置 {#configure-from-environment}

在 Hub 之外管理应用密钥的部署需要同时设置以下三个环境变量：

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
```

在 Linear 应用中配置相同的 Redirect URL 和 Webhook URL，重启 Hub，打开 **Integrations**，然后选择 **Connect a Linear workspace** 完成工作区授权。

环境变量配置优先于已保存的 Linear 应用，并在 **Apps** 下显示为 **Managed by environment**。
