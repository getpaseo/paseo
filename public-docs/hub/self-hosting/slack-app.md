---
title: Slack for Hub
description: Create the Slack app your Hub uses, connect a workspace, and write Slack triggers.
nav: Slack app
order: 76
category: Hub
---

# Slack for Hub

Hub receives Slack mentions over the Events API. Socket Mode is not used, so your Hub needs a publicly reachable HTTPS origin with a valid certificate. See [Public ingress and TLS](/docs/hub/self-hosting#public-ingress-and-tls).

## Create the app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From a manifest**, and paste this after replacing `hub.example.com` with your `PASEO_HUB_APP_URL`:

```yaml
display_information:
  name: Paseo
features:
  bot_user:
    display_name: Paseo
    always_online: false
oauth_config:
  redirect_urls:
    - https://hub.example.com/api/integrations/slack/callback
  scopes:
    bot:
      - app_mentions:read
      - chat:write
      - reactions:write
settings:
  event_subscriptions:
    request_url: https://hub.example.com/api/integrations/slack/events
    bot_events:
      - app_mention
  interactivity:
    is_enabled: false
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
```

## Configure Hub

From **Basic Information → App Credentials**, copy:

| Value          | Environment variable   |
| -------------- | ---------------------- |
| App ID         | `SLACK_APP_ID`         |
| Client ID      | `SLACK_CLIENT_ID`      |
| Client Secret  | `SLACK_CLIENT_SECRET`  |
| Signing Secret | `SLACK_SIGNING_SECRET` |

Restart Hub before Slack verifies the request URL. Hub needs the signing secret to answer the verification challenge.

## Connect

Open **Connections → Slack → Connect**, pick the workspace, and allow it.

Use Hub's button, not Slack's **Install to Workspace**. The install has to start from Hub so the workspace binds to your organization.

Then invite the bot to each channel it should watch:

```text
/invite @Paseo
```

Now write a trigger: [Slack triggers](/docs/hub/triggers/slack).
