---
title: Linear for Hub
description: Connect a Linear app and send issue and comment events to your self-hosted Hub.
nav: Linear app
order: 77
category: Hub
---

# Linear for Hub

Open your self-hosted Hub at its [public HTTPS address](/docs/hub/self-hosting#public-addresses). A Linear workspace admin authorizes the app.

1. In Hub, open **Apps → Linear**. Copy the **Redirect URL** and **Webhook URL**.
2. In [Linear API applications](https://linear.app/settings/api/applications), create an OAuth application and add the redirect URL to its OAuth settings.
3. Enable the app webhook for **Issue** and **Comment** events. Use the webhook URL from Hub and copy the signing secret.
4. Back in Hub, enter the **Client ID**, **Client Secret**, and **Webhook signing secret**. Choose **Save and continue to Linear** and authorize the workspace.

Check the workspace under **Connections** in Hub 0.11.0 or **Integrations** in newer builds.

For a Hub at `https://hub.example.com`, the redirect URL is `https://hub.example.com/api/integrations/linear/callback` and the webhook URL is `https://hub.example.com/api/integrations/linear/events`.

Hub requests `read` and `comments:create` and posts replies as the app. See [Linear triggers](/docs/hub/triggers/linear) to deploy your first workflow.

## Configure from environment

Set these variables when your deployment supplies app credentials:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
```

Use the same redirect and webhook URLs. Restart Hub, open the organization's connection page, and authorize the Linear workspace.
