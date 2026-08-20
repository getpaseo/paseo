---
title: Slack for Hub
description: Connect Slack over Socket Mode, or use webhooks from a public Hub.
nav: Slack app
order: 76
category: Hub
---

# Slack for Hub

Slack can reach Hub in two ways:

| Transport   | Public HTTPS required | Best for                                |
| ----------- | --------------------- | --------------------------------------- |
| Socket Mode | No                    | Local, personal, and single-process Hub |
| Webhooks    | Yes                   | Public server deployments               |

Socket Mode is the default in browser setup. Both transports produce the same `slack.mention` triggers and thread replies.

## Set up Socket Mode

Open **Apps → Slack** in Hub and keep **Socket Mode** selected. Hub gives you the Slack manifest and the exact steps to:

1. Create the Slack app from the manifest.
2. Generate an App-level token with `connections:write`.
3. Install the app and copy its Bot User OAuth Token.

Paste both tokens into Hub and choose **Connect Slack**. Hub verifies the installation, saves it for the active organization, and opens the outbound Socket Mode connection.

Invite the bot to each channel it should watch:

```text
/invite @Paseo
```

Now write a [Slack trigger](/docs/hub/triggers/slack).

Socket Mode holds one live connection in the Hub process. Run one Hub process for this transport and keep it running; events that arrive while it is stopped are missed.

## Use webhooks

Choose **Webhooks** when Slack should send events to a stable public Hub. Hub must be open at its public HTTPS address before setup so the generated redirect and request URLs are correct.

The Apps guide gives you a webhook manifest and asks for the App ID, Client ID, Client Secret, and Signing Secret. Saving continues to Slack so you can install the app into a workspace.

Slack calls:

| Provider setting | Hub URL                                               |
| ---------------- | ----------------------------------------------------- |
| Redirect URL     | `<PASEO_HUB_APP_URL>/api/integrations/slack/callback` |
| Request URL      | `<PASEO_HUB_APP_URL>/api/integrations/slack/events`   |

Start the installation from Hub. An installation started only from Slack is not bound to a Hub organization.

## Configure from environment

Deployments that keep app secrets outside Hub can use one complete transport configuration.

Socket Mode:

```dotenv
SLACK_TRANSPORT=socket
SLACK_APP_ID=A01234567
SLACK_APP_TOKEN=xapp-...
```

The Bot User OAuth Token remains attached to each saved Slack workspace connection; it is not part of the Socket Mode environment configuration.

Webhooks:

```dotenv
SLACK_TRANSPORT=webhook
SLACK_APP_ID=A01234567
SLACK_CLIENT_ID=...
SLACK_CLIENT_SECRET=...
SLACK_SIGNING_SECRET=...
```

Environment configuration takes precedence over a saved Slack app and appears as **Managed by environment** under **Apps**.
