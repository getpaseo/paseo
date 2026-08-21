---
title: Discord for Hub
description: Create the Discord application your Hub uses and connect a server.
nav: Discord app
order: 77
category: Hub
---

# Discord for Hub

Hub connects out to Discord through the gateway. Discord does not send event webhooks to Hub, so the bot does not need a public inbound endpoint.

Open **Apps → Discord**. Hub gives you the redirect URL and the exact steps to create the application, enable its bot, and copy the Application ID, Client Secret, and Bot token.

Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. Without it, the bot receives empty messages and no trigger can match. Server Members Intent is not needed.

Paste the credentials into Hub and choose **Verify and save**. Then choose **Add to a Discord server** and authorize the server. Start the authorization from Hub so the server is bound to the active Hub organization.

One Discord application and gateway connection serves every organization and server connected to this Hub. Keep the Hub process running; events that arrive while it is stopped are missed.

Now write a [Discord trigger](/docs/hub/triggers/discord).

## Configure from environment

Deployments that keep app secrets outside Hub can set:

```dotenv
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

`DISCORD_CLIENT_ID` is the Application ID shown under **General Information**. Environment configuration takes precedence over a saved Discord application and appears as **Managed by environment** under **Apps**.
