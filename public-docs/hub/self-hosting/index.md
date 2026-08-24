---
title: Self-hosting Hub
description: Run Hub locally with its embedded database, or deploy it with PostgreSQL.
nav: Self-hosting
order: 74
category: Hub
---

# Self-hosting Hub

The shortest path is one command:

```sh
npx @getpaseo/hub
```

Open <http://localhost:3000>. A fresh Hub creates its embedded database and authentication secret, then guides you through creating the operator account and the GitHub, Slack, or Discord apps you want.

Follow the [quickstart](/docs/hub/quickstart) to connect Slack over Socket Mode and run the first workflow without a public server.

## Local data

Without `DATABASE_URL`, Hub stores an embedded PGlite database and its generated authentication secret under `$XDG_DATA_HOME/paseo-hub`. If `XDG_DATA_HOME` is not set to an absolute path, Hub uses `~/.local/share/paseo-hub`. Both survive restarts.

Set a different location explicitly with:

```sh
PASEO_HUB_DATA_DIR=/path/to/paseo-hub-data npx @getpaseo/hub
```

Embedded mode supports one Hub process per data directory. It is intended for a personal or single-process Hub. Back up the whole data directory before upgrading or moving it.

## Public addresses

Hub defaults to `http://localhost:3000`. That is enough for its dashboard, daemons, Slack Socket Mode, and providers that connect out from Hub.

GitHub event triggers use webhooks and need a public HTTPS address. Repository access can still work without the webhook. Slack's optional Webhooks transport also needs public HTTPS; Socket Mode does not.

When Hub is available at a stable public origin, set it before starting:

```sh
PASEO_HUB_APP_URL=https://hub.example.com npx @getpaseo/hub
```

Changing the public origin requires updating callback and webhook settings in the provider apps. The **Apps** page generates the URLs for the origin Hub is currently using.

## PostgreSQL

Set `DATABASE_URL` to use PostgreSQL instead of the embedded database:

```sh
DATABASE_URL=postgres://paseo:password@localhost:5432/paseo_hub \
  npx @getpaseo/hub
```

Use PostgreSQL for a durable server deployment, more than one Hub process, or an existing database backup and operations setup. Migrations run automatically at startup. Hub does not start listening when a migration fails.

The database also stores Hub's generated authentication secret. Set `PASEO_HUB_AUTH_SECRET` only when the deployment must supply that secret from a platform secret store. While the override is set, Hub uses it without replacing the stored secret. Changing the effective secret signs everyone out of the dashboard; execution credentials already issued remain valid until their execution ends.

## App configuration

The operator configures GitHub, Slack, and Discord under **Apps**. Hub verifies the credentials before saving them in its database and starts the same provider runtime used by environment-configured deployments.

Environment variables remain available for deployments that manage secrets outside Hub. A complete environment configuration takes precedence over a saved application and appears as **Managed by environment** in the dashboard.

```sh
# GitHub
GITHUB_APP_SLUG=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=          # or GITHUB_APP_PRIVATE_KEY_PATH
GITHUB_WEBHOOK_SECRET=

# Slack Socket Mode
SLACK_TRANSPORT=socket
SLACK_APP_ID=
SLACK_APP_TOKEN=

# Slack Webhooks instead of Socket Mode
SLACK_TRANSPORT=webhook
SLACK_APP_ID=
SLACK_CLIENT_ID=
SLACK_CLIENT_SECRET=
SLACK_SIGNING_SECRET=

# Discord
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_BOT_TOKEN=
```

See [GitHub](/docs/hub/self-hosting/github-app), [Slack](/docs/hub/self-hosting/slack-app), and [Discord](/docs/hub/self-hosting/discord-app) for provider behavior and connection steps.

## Bootstrap from environment

Browser setup is the default for a fresh database. An unattended deployment can create the first operator from environment variables instead:

```dotenv
PASEO_BOOTSTRAP_ORGANIZATION=My organization
PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com
PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

The password must be at least 12 characters. Sign in once, replace it in the dashboard, then remove `PASEO_BOOTSTRAP_OWNER_PASSWORD`. Hub keeps the account and organization.

## Docker Compose

The repository contains Hub and PostgreSQL as one Compose stack:

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp .env.example .env
docker compose up -d
```

Open <http://localhost:3000> and complete browser setup. For a public deployment, set `PASEO_HUB_APP_URL` and any reverse-proxy settings in `.env` before starting the stack.

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

Deploy the Dockerfile and give Hub its public origin:

```sh
fly deploy -a your-hub \
  -e PASEO_HUB_APP_URL=https://your-hub.fly.dev
```

Open that address and complete browser setup, or set the [bootstrap environment](#bootstrap-from-environment) before deploying.

Keep one machine running. Hub holds Slack Socket Mode and Discord gateway connections and dispatches events to daemons, so a stopped machine misses events.

## Upgrades

Pull the new image or source and deploy it. Migrations are forward-only. Back up the embedded data directory or PostgreSQL database first; it contains accounts, app credentials, configuration revisions, connections, and execution history.
