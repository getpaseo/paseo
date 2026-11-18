---
title: 为 Hub 配置 Linear
description: 连接 Linear 应用，将 issue 和评论事件发送到你的自托管 Hub。
nav: Linear 应用
---

# 为 Hub 配置 Linear {#linear-for-hub}

通过[公开 HTTPS 地址](/docs/hub/self-hosting#public-addresses)打开你的自托管 Hub。Linear 工作区管理员需要授权应用。

1. 在 Hub 中打开 **Apps → Linear**。复制 **Redirect URL** 和 **Webhook URL**。
2. 在 [Linear API 应用](https://linear.app/settings/api/applications)中创建 OAuth 应用，然后将重定向 URL 添加到它的 OAuth 设置中。
3. 为应用启用 **Issue** 和 **Comment** 事件的 webhook。使用 Hub 提供的 webhook URL，并复制签名密钥。
4. 返回 Hub，填写 **Client ID**、**Client Secret** 和 **Webhook signing secret**。选择 **Save and continue to Linear** 并授权工作区。

在 Hub 0.11.0 的 **Connections** 页面或新版的 **Integrations** 页面检查工作区。

如果 Hub 位于 `https://hub.example.com`，重定向 URL 为 `https://hub.example.com/api/integrations/linear/callback`，webhook URL 为 `https://hub.example.com/api/integrations/linear/events`。

Hub 请求 `read` 和 `comments:create` 权限，并以应用身份发布回复。参阅 [Linear 触发器](/docs/hub/triggers/linear)部署第一个 workflow。

## 通过环境变量配置 {#configure-from-environment}

如果部署环境提供应用凭据，请设置这些变量：

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
```

使用相同的重定向和 webhook URL。重启 Hub，打开组织的连接页面并授权 Linear 工作区。
