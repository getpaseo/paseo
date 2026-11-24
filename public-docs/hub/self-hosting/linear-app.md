---
title: Linear for Hub
description: Create a Linear OAuth app and connect a Linear workspace to your self-hosted Hub.
nav: Linear app
order: 79
category: Hub
---

# Linear for Hub

Linear webhooks require HTTPS. Open your self-hosted Hub at its [public HTTPS address](/docs/hub/self-hosting#public-addresses) before setting up Linear. A Linear workspace administrator must authorize the app.

## Set up the Linear app

1. In Hub, open **Apps → Linear**. Copy the **Redirect URL** and **Webhook URL**.
2. Open [Linear API applications](https://linear.app/settings/api/applications), create an OAuth application, and add the **Redirect URL** to its OAuth settings.
3. Enable webhooks for **Issue** and **Comment** events using the **Webhook URL** from Hub, and copy the webhook signing secret.
4. Return to Hub and paste the **Client ID**, **Client Secret**, and **Webhook signing secret**.
5. Choose **Save and continue to Linear** and authorize the Linear workspace.

Verify the connected workspace under **Integrations** in Hub. Each connected workspace receives a connection slug, such as `acme-linear`, that triggers reference.

Linear calls these Hub URLs:

| Setting      | Hub URL                                                |
| ------------ | ------------------------------------------------------ |
| Redirect URL | `<PASEO_HUB_APP_URL>/api/integrations/linear/callback` |
| Webhook URL  | `<PASEO_HUB_APP_URL>/api/integrations/linear/events`   |

Hub requests the `read` and `comments:create` OAuth scopes and posts replies as the Linear app. Next, create a workflow with [Linear triggers](/docs/hub/triggers/linear).

## Configure from environment

Deployments that keep app secrets outside Hub can set all three environment variables:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
```

Configure the same Redirect URL and Webhook URL in your Linear application, restart Hub, open **Integrations**, and choose **Connect a Linear workspace** to authorize the workspace.

Environment configuration takes precedence over a saved Linear app and appears as **Managed by environment** under **Apps**.
