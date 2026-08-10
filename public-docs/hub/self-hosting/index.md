---
title: Self-hosting Hub
description: Deploy Paseo Hub with PostgreSQL and a public HTTPS origin, using Docker Compose or Fly.
nav: Self-hosting
order: 74
category: Hub
---

# Self-hosting Hub

Hub is a Node service backed by PostgreSQL. Connecting external providers requires a public HTTPS URL for their callbacks and webhooks.

1. Deploy Hub with [Docker Compose](#docker-compose) or [Fly](#fly).
2. Create the [GitHub App](/docs/hub/self-hosting/github-app), [Slack app](/docs/hub/self-hosting/slack-app), and [Discord app](/docs/hub/self-hosting/discord-app) you want.
3. Follow the [quickstart](/docs/hub/quickstart).

Migrations run automatically at startup. Hub does not start listening when a migration fails.

## Configuration

Hub has one public URL and one persistent application secret:

| Variable                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `PASEO_HUB_APP_URL`     | Public origin used by the dashboard, authentication, callbacks, and webhooks |
| `PASEO_HUB_AUTH_SECRET` | Protects browser sessions and derives execution credentials                  |
| `DATABASE_URL`          | PostgreSQL connection string                                                 |

Generate `PASEO_HUB_AUTH_SECRET` once and keep it across restarts:

```sh
openssl rand -hex 32
```

Changing it signs everyone out and invalidates completion credentials for executions that are still running.

Bootstrap the first owner with:

```dotenv
PASEO_BOOTSTRAP_ORGANIZATION=My organization
PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com
PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

The password must be at least 12 characters. Sign in with it once, replace it in the dashboard, then remove `PASEO_BOOTSTRAP_OWNER_PASSWORD` from the deployment. Hub keeps the account and organization.

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

## Docker Compose

The repository contains Hub and PostgreSQL as one Compose stack:

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp .env.example .env
```

Set `PASEO_HUB_APP_URL`, `PASEO_HUB_AUTH_SECRET`, and the three bootstrap values in `.env`, then run:

```sh
docker compose up -d
```

The stack publishes Hub on port `3000` and stores PostgreSQL data in a named volume. The Hub image is `ghcr.io/getpaseo/hub:latest`.

### HTTPS with Caddy

Compose serves plain HTTP on port `3000`. Run Caddy on the same host to terminate TLS:

```caddyfile
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Point `hub.example.com` at the host and open ports 80 and 443. Caddy [obtains and renews the certificate](https://caddyserver.com/docs/automatic-https).

Then set in `.env`:

```dotenv
PASEO_HUB_APP_URL=https://hub.example.com
PASEO_HUB_TRUSTED_CLIENT_IP_HEADER=x-forwarded-for
```

To keep port `3000` off the public interface, change the `hub` port in `compose.yml` to `"127.0.0.1:3000:3000"`.

## Fly

Clone the repository and create an app and database under names you control:

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
fly apps create your-hub
fly postgres create --name your-hub-db
fly postgres attach your-hub-db -a your-hub
```

Set the application secret and bootstrap account, along with credentials for the providers you use:

```sh
fly secrets set -a your-hub \
  PASEO_HUB_AUTH_SECRET="$(openssl rand -hex 32)" \
  PASEO_BOOTSTRAP_ORGANIZATION="My organization" \
  PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com \
  PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

Deploy the Dockerfile from the repository:

```sh
fly deploy -a your-hub \
  -e PASEO_HUB_APP_URL=https://your-hub.fly.dev
```

Keep one machine running. Hub holds the Discord gateway connection and dispatches events to daemons, so a stopped machine misses events.

## Provider URLs

Slack and GitHub call Hub at `PASEO_HUB_APP_URL`:

| Provider setting             | URL                                                    |
| ---------------------------- | ------------------------------------------------------ |
| GitHub webhook               | `<PASEO_HUB_APP_URL>/webhook`                          |
| GitHub OAuth callback        | `<PASEO_HUB_APP_URL>/api/integrations/github/callback` |
| Slack Events API request URL | `<PASEO_HUB_APP_URL>/api/integrations/slack/events`    |
| Slack OAuth callback         | `<PASEO_HUB_APP_URL>/api/integrations/slack/callback`  |

Slack requires the Events API request URL to be publicly reachable over HTTPS with a valid certificate, and its [OAuth redirect URL](https://docs.slack.dev/authentication/installing-with-oauth/) must use HTTPS. See Slack's [HTTP request URL](https://docs.slack.dev/apis/events-api/using-http-request-urls/) requirements.

GitHub must reach the webhook URL and [verifies SSL certificates](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#use-https-and-ssl-verification) by default.

A Hub on `localhost` or a LAN address still runs manual and daemon workflows, but Slack and GitHub cannot reach it. To test provider setup locally, point `PASEO_HUB_APP_URL` at an HTTPS tunnel before starting Hub. A changed tunnel origin requires updated provider settings and a Hub restart.

## Upgrades

Pull the new image or source and deploy it. Migrations are forward-only. Back up PostgreSQL first; it contains configuration revisions, connections, and execution history.
