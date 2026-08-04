---
title: Self-hosting Hub
description: Deploy Paseo Hub with Postgres and a public HTTPS origin, on Fly or with Docker.
nav: Self-hosting
order: 73
category: Hub
---

# Self-hosting Hub

Hub is a Node service backed by PostgreSQL. It needs a public HTTPS origin, because GitHub and Slack deliver events to it over the internet.

Getting it running takes three steps: deploy the service, create the provider apps it talks to, then use it.

1. Deploy, below.
2. Create the [GitHub App](/docs/hub/self-hosting/github-app), [Slack app](/docs/hub/self-hosting/slack-app), and [Discord app](/docs/hub/self-hosting/discord-app) you want.
3. Follow the [quickstart](/docs/hub/quickstart).

## Requirements

- PostgreSQL 14 or newer.
- A public HTTPS origin, for example `https://hub.example.com`.
- A secret store you control. Two of these secrets must survive restarts.

Migrations run automatically at startup. If a migration fails, the process does not start listening.

## Environment

### Required

| Variable                              | Purpose                                         |
| ------------------------------------- | ----------------------------------------------- |
| `DATABASE_URL`                        | PostgreSQL connection string                    |
| `PASEO_CLOUD_PUBLIC_URL`              | Public origin, used to build every callback URL |
| `BETTER_AUTH_URL`                     | Same origin, for the dashboard's auth           |
| `BETTER_AUTH_SECRET`                  | Session signing key                             |
| `PASEO_CLOUD_COMPLETION_TOKEN_SECRET` | Derives the per-execution MCP bearer tokens     |

Generate the two secrets once and persist them:

```sh
openssl rand -base64 32
```

Rotating `PASEO_CLOUD_COMPLETION_TOKEN_SECRET` invalidates the completion callback of every execution still running. Hub refuses to dispatch at all when it is missing.

The `PASEO_CLOUD_` prefix is historical. The product is Hub.

### Providers

Set the group for each provider you intend to connect. A provider with missing credentials shows as **Setup needed** in Connections.

```sh
# GitHub
GITHUB_APP_SLUG=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=          # or GITHUB_APP_PRIVATE_KEY_PATH
GITHUB_WEBHOOK_SECRET=

# Slack
SLACK_APP_ID=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=

# Discord
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

See [GitHub](/docs/hub/self-hosting/github-app), [Slack](/docs/hub/self-hosting/slack-app), and [Discord](/docs/hub/self-hosting/discord-app) for where each value comes from.

### Optional

| Variable                               | Default   | Purpose                                                 |
| -------------------------------------- | --------- | ------------------------------------------------------- |
| `PORT`                                 | `3000`    | Listen port                                             |
| `PASEO_CLOUD_BIND`                     | `0.0.0.0` | Bind address                                            |
| `PASEO_CLOUD_TRUSTED_CLIENT_IP_HEADER` | unset     | Client IP header when behind a proxy                    |
| `PASEO_ADMIN_TOKEN`                    | unset     | Opens the admin routes. Leave unset to keep them closed |

## Docker

```sh
docker run --env-file .env -p 3000:3000 paseo-cloud
```

Put the same origin in `PASEO_CLOUD_PUBLIC_URL` that your reverse proxy serves, and set `PASEO_CLOUD_TRUSTED_CLIENT_IP_HEADER` to whatever header your proxy sets.

## Fly

`fly.toml` holds the non-secret configuration:

```toml
[env]
  PORT = '3000'
  PASEO_CLOUD_PUBLIC_URL = 'https://hub.example.com'
  PASEO_CLOUD_TRUSTED_CLIENT_IP_HEADER = 'fly-client-ip'

[http_service]
  internal_port = 3000
  force_https = true
  min_machines_running = 1
```

Install secrets separately so they are not in the repository:

```sh
fly secrets set -a your-app \
  BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \
  PASEO_CLOUD_COMPLETION_TOKEN_SECRET="$(openssl rand -base64 32)"
```

Keep `min_machines_running = 1`. Hub holds the Discord gateway connection and dispatches to daemons; a stopped machine misses events.

## First account

Sign up through the dashboard. The first account creates its own organization. From there, the [quickstart](/docs/hub/quickstart) takes over.

For a deployment that already has tenant data, such as a migration from an earlier install, `PASEO_BOOTSTRAP_OWNER_EMAIL` selects one account and `PASEO_BOOTSTRAP_CLAIM_SECRET` supplies the proof, delivered out of band. Matching the email alone never claims ownership. Remove both once the membership exists.

## Upgrades

Deploy the new image. Migrations run at startup and are forward-only, with no down migrations. Back up the database before an upgrade; that database holds your configuration revisions, connections, and execution history.
