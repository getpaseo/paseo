---
title: Self-hosting Hub
description: Deploy Paseo Hub with PostgreSQL and a public HTTPS origin.
nav: Self-hosting
order: 74
category: Hub
---

# Self-hosting Hub

Hub is a Node service backed by PostgreSQL. [Fly](#fly) is the shortest path to hosted ingress and TLS. You can also run Hub privately behind [Caddy or another reverse proxy](#reverse-proxy), or use an [HTTPS tunnel](#testing-with-a-tunnel).

1. Deploy Hub with [Fly](#fly) or a [reverse proxy](#reverse-proxy).
2. Create the [GitHub App](/docs/hub/self-hosting/github-app), [Slack app](/docs/hub/self-hosting/slack-app), and [Discord app](/docs/hub/self-hosting/discord-app) you want.
3. Follow the [quickstart](/docs/hub/quickstart).

Migrations run automatically at startup. Hub does not start listening when a migration fails.

## Configuration

Hub has one public URL and one persistent application secret:

| Variable                | Purpose                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `PASEO_HUB_APP_URL`     | Canonical externally reachable origin for the UI, authentication, callbacks, and webhooks |
| `PASEO_HUB_AUTH_SECRET` | Protects browser sessions and derives execution credentials                               |
| `DATABASE_URL`          | PostgreSQL connection string                                                              |

Generate `PASEO_HUB_AUTH_SECRET` once and keep it across restarts:

```sh
openssl rand -hex 32
```

Changing it signs everyone out and invalidates completion credentials for executions that are still running.

Use an HTTPS origin with no path:

```dotenv
PASEO_HUB_APP_URL=https://hub.example.com
```

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

## Public ingress and TLS

Slack and GitHub must reach Hub at `PASEO_HUB_APP_URL`:

| Provider setting             | URL                                                    |
| ---------------------------- | ------------------------------------------------------ |
| GitHub webhook               | `<PASEO_HUB_APP_URL>/webhook`                          |
| GitHub OAuth callback        | `<PASEO_HUB_APP_URL>/api/integrations/github/callback` |
| Slack Events API request URL | `<PASEO_HUB_APP_URL>/api/integrations/slack/events`    |
| Slack OAuth callback         | `<PASEO_HUB_APP_URL>/api/integrations/slack/callback`  |

Slack requires the Events API request URL to be publicly reachable over HTTPS with a valid certificate, and its OAuth redirect URL must use HTTPS. See Slack's [HTTP request URL](https://docs.slack.dev/apis/events-api/using-http-request-urls/) and [OAuth installation](https://docs.slack.dev/authentication/installing-with-oauth/) requirements.

GitHub webhooks must be reachable from GitHub. GitHub recommends HTTPS and verifies SSL certificates by default. See GitHub's [webhook security guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#use-https-and-ssl-verification) and [private-system delivery options](https://docs.github.com/en/webhooks/using-webhooks/delivering-webhooks-to-private-systems).

A Hub reachable only through `localhost` or a LAN address can run manual and daemon workflows, but cannot receive Slack or GitHub events directly.

## Reverse proxy

Keep PostgreSQL and Hub private. Expose only the proxy's public HTTPS origin. For a Hub process listening on `127.0.0.1:3000`, a minimal Caddy configuration is:

```caddyfile
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Point public DNS at the proxy and allow inbound ports 80 and 443. Caddy then [provisions and renews HTTPS certificates](https://caddyserver.com/docs/automatic-https). For a Hub process running directly on the proxy host, set:

```dotenv
PASEO_HUB_BIND=127.0.0.1
PASEO_HUB_APP_URL=https://hub.example.com
PASEO_HUB_TRUSTED_CLIENT_IP_HEADER=x-forwarded-for
```

If Hub runs in Docker, bind its port to loopback instead of all interfaces:

```yaml
services:
  postgres:
    image: postgres:17
    environment:
      POSTGRES_DB: paseo_hub
      POSTGRES_USER: paseo
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - paseo-hub-db:/var/lib/postgresql/data
  hub:
    image: ghcr.io/getpaseo/hub:latest
    depends_on: [postgres]
    env_file: .env
    environment:
      DATABASE_URL: postgres://paseo:${POSTGRES_PASSWORD}@postgres:5432/paseo_hub
      PASEO_HUB_BIND: 0.0.0.0
    ports:
      - "127.0.0.1:3000:3000"

volumes:
  paseo-hub-db:
```

Do not publish PostgreSQL. Run Caddy on the host, or place an equivalent TLS proxy on the same private network as Hub.

## Testing with a tunnel

An HTTPS tunnel can expose local Hub temporarily while you test provider setup. Set `PASEO_HUB_APP_URL` to the tunnel's stable HTTPS origin before starting Hub, and configure the provider URLs above. A changed tunnel origin requires updated provider settings and a Hub restart.

## Upgrades

Pull the new image or source and deploy it. Migrations are forward-only. Back up PostgreSQL first; it contains configuration revisions, connections, and execution history.
