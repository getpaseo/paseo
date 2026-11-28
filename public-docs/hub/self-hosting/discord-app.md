---
title: Discord for Hub
description: Create the Discord application your self-hosted Hub uses and connect a server.
nav: Discord app
order: 81
category: Hub
---

# Discord for Hub

Hub connects out to Discord through the Discord gateway. Discord does not send event webhooks to Hub, so the bot needs no public inbound HTTPS endpoint.

## Set up the Discord app

1. Open **Apps → Discord** in Hub. Copy the redirect URL and follow the steps to create the Discord application and enable its bot.
2. Under **Bot → Privileged Gateway Intents** in Discord, enable **Message Content Intent**. Without it, the bot receives empty messages and triggers cannot match. **Server Members Intent** is not needed.
3. Paste the **Application ID**, **Client Secret**, and **Bot token** into Hub and choose **Verify and save**.
4. Choose **Add to a Discord server** from Hub and authorize the server so it binds to the active Hub organization under **Integrations**.

One Discord application and gateway connection serves every organization and server connected to this Hub. Keep the Hub process running because events that arrive while it is stopped are missed.

A connected Discord server supports both [Discord triggers](/docs/hub/triggers/discord) and [scoped Discord integration tools](/docs/hub/tools).

## Configure from environment

Deployments that manage app secrets outside Hub can set:

```dotenv
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

`DISCORD_CLIENT_ID` is the **Application ID** shown under **General Information** in Discord. Environment configuration takes precedence over a saved Discord application and appears as **Managed by environment** under **Apps**.
