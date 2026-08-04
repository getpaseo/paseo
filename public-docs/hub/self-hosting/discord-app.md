---
title: Discord for Hub
description: Create the Discord application your Hub uses, connect a guild, and write Discord triggers.
nav: Discord app
order: 76
category: Hub
---

# Discord for Hub

Hub connects to Discord over the gateway with a bot you own. Unlike GitHub and Slack, Discord does not post to your Hub. Hub holds an outbound connection, so it needs no public webhook beyond the OAuth callback.

## Create the application

Go to the [Discord developer portal](https://discord.com/developers/applications) → **New Application**.

Under **Bot**:

- Add a bot and copy its token.
- Enable **Message Content Intent**. Without it the bot receives empty messages and no trigger can match.
- Server Members Intent is not needed.

Under **OAuth2**, add the redirect URL:

```text
https://hub.example.com/api/integrations/discord/callback
```

Replace `hub.example.com` with your `PASEO_CLOUD_PUBLIC_URL`.

## Configure Hub

| Value          | Environment variable    |
| -------------- | ----------------------- |
| Application ID | `DISCORD_CLIENT_ID`     |
| Client Secret  | `DISCORD_CLIENT_SECRET` |
| Bot token      | `DISCORD_BOT_TOKEN`     |

Restart Hub. Discord shows as **Ready** in Connections.

## Connect

Open **Connections → Discord → Connect**, choose the server, and authorize. Hub builds the invite with the permissions the bot needs, so you do not construct an invite URL yourself.

The connection appears with a slug derived from the guild name.

Because Hub holds one gateway connection for the whole deployment, one bot serves every organization and guild you connect.

Now write a trigger: [Discord triggers](/docs/hub/triggers/discord).
