---
title: Linear for Hub
description: Create the Linear application your Hub uses for project triggers, agent sessions, and replies.
nav: Linear app
order: 79
category: Hub
---

# Linear for Hub

Hub connects to Linear through an OAuth application you create and own. One application serves
the Hub; each Linear workspace an administrator authorizes becomes a separate connection.

Linear setup requires a stable public HTTPS origin. Set `PASEO_HUB_APP_URL` and open Hub at that
address before starting the Apps guide. Hub does not persist an application setup attempted from
plain HTTP.

## Create the application

Open **Apps → Linear**. Hub links to Linear's API application settings and gives you the exact URLs
for the current origin:

| Linear setting | Hub URL                                                |
| -------------- | ------------------------------------------------------ |
| Redirect URL   | `<PASEO_HUB_APP_URL>/api/integrations/linear/callback` |
| Webhook URL    | `<PASEO_HUB_APP_URL>/api/integrations/linear/events`   |

In Linear:

1. Create an OAuth application and add the redirect URL.
2. Add application webhooks for **Issue**, **Comment**, and **Agent session events** at the webhook
   URL. Agent session events let people mention the app or delegate an issue to it.
3. Choose a webhook signing secret.
4. Copy the Client ID, Client Secret, and signing secret into Hub.

Choose **Save and continue to Linear**. A workspace administrator authorizes the application with
`read`, `write`, `app:assignable`, and `app:mentionable`. The two app scopes make the application
available as an issue delegate and an @mention target; `write` lets it emit native Agent
Activities. Hub saves the application and workspace connection only after that authorization
succeeds. Replaying a completed or expired authorization link is rejected.

An existing Linear connection that predates these scopes appears as requiring reauthorization.
Reconnect it once to enable native agent sessions.

The OAuth request uses Linear's app actor. Ordinary issue-trigger replies are visibly authored by
the application; an agent-session reply is emitted as a native `response` activity on that
session.

Linear currently labels its Agent APIs as Developer Preview, so its upstream contract may change.

Choose **Connect another workspace** to authorize more workspaces. Each connection gets its own
Hub slug for `filters.connection`.

## Configure from environment

Deployments that keep application secrets outside Hub can set all three values:

```dotenv
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=
```

Environment configuration takes precedence over a saved Linear application and appears as
**Managed by environment** under **Apps**. A workspace administrator must still complete OAuth for
each workspace connection; those workspace tokens are stored by Hub.

## Webhook verification

Keep Linear's webhook signing secret and Hub's `LINEAR_WEBHOOK_SECRET` identical. Hub verifies the
HMAC against the raw request body and rejects a signed timestamp more than one minute in the past
or future. Invalid, missing, malformed, and stale signatures do not reach trigger matching.

Continue with [Linear triggers](/docs/hub/triggers/linear).
