---
title: Self-hosting Hub
description: Run Hub locally with its embedded database, or deploy it with PostgreSQL, Docker Compose, or Fly.
nav: Self-hosting
order: 77
category: Hub
---

# Self-hosting Hub

The shortest path to a local Hub is one command:

```sh
npx @getpaseo/hub
```

Open <http://localhost:3000>. A fresh Hub creates its embedded database and authentication secret, then guides you through creating the operator account and setting up the GitHub, Linear, Slack, or Discord apps you need.

Follow the [quickstart](/docs/hub/quickstart) to connect Slack over Socket Mode and run your first trigger without a public server.

## Local data

Without `DATABASE_URL`, Hub stores an embedded PGlite database and its generated authentication secret under `$XDG_DATA_HOME/paseo-hub`. If `XDG_DATA_HOME` is not set to an absolute path, Hub uses `~/.local/share/paseo-hub`. Both survive restarts.

Set a custom directory with `PASEO_HUB_DATA_DIR`:

```sh
PASEO_HUB_DATA_DIR=/path/to/paseo-hub-data npx @getpaseo/hub
```

Embedded mode supports one Hub process per data directory and fits a personal or single-process Hub. Back up the whole data directory before upgrading or moving it.

## Public addresses

Hub defaults to `http://localhost:3000`. That address is enough for the dashboard, daemons, Slack Socket Mode, Discord gateway, and schedules.

A public HTTPS address is required for:

- GitHub event webhooks (GitHub repository access still works without webhooks)
- Linear OAuth callbacks and webhooks
- Slack Webhooks transport (Socket Mode does not need HTTPS)
- Inbound webhook triggers (`/webhooks/wh_...`)
- **Open in Paseo** links appended to conversation replies

Set your public HTTPS origin before starting Hub:

```sh
PASEO_HUB_APP_URL=https://hub.example.com npx @getpaseo/hub
```

If you change the public origin later, update callback and webhook URLs in your provider apps. The **Apps** page generates URLs for the origin Hub is currently using.

## PostgreSQL

Set `DATABASE_URL` to use PostgreSQL instead of the embedded database:

```sh
DATABASE_URL=postgres://paseo:password@localhost:5432/paseo_hub \
  npx @getpaseo/hub
```

Use PostgreSQL for a durable server deployment, multiple Hub processes, or standard database backups. Migrations run automatically at startup, and Hub refuses to listen if a migration fails.

The database also stores Hub's generated authentication secret. Set `PASEO_HUB_AUTH_SECRET` only when your platform injects that secret from an external secret store. While set, Hub uses the override without replacing the stored secret. Changing the active secret signs dashboard users out, while running executions keep their existing credentials until they end.

## App configuration

The instance operator configures GitHub, Linear, Slack, and Discord under **Apps**. Hub verifies credentials before saving them in its database and starts the same provider runtime used by environment-configured deployments.

Environment variables remain available when your deployment manages secrets outside Hub. A complete environment configuration takes precedence over a saved application and appears as **Managed by environment** under **Apps**.

```sh
# GitHub
GITHUB_APP_SLUG=
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=          # or GITHUB_APP_PRIVATE_KEY_PATH
GITHUB_WEBHOOK_SECRET=

# Linear
LINEAR_CLIENT_ID=
LINEAR_CLIENT_SECRET=
LINEAR_WEBHOOK_SECRET=

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

Read the setup guide for each provider:

- [GitHub app](/docs/hub/self-hosting/github-app)
- [Linear app](/docs/hub/self-hosting/linear-app)
- [Slack app](/docs/hub/self-hosting/slack-app)
- [Discord app](/docs/hub/self-hosting/discord-app)

## Bootstrap from environment

Browser setup is the default for a fresh database. For an unattended deployment, create the first operator from environment variables instead:

```dotenv
PASEO_BOOTSTRAP_ORGANIZATION=My organization
PASEO_BOOTSTRAP_OWNER_EMAIL=me@example.com
PASEO_BOOTSTRAP_OWNER_PASSWORD=replace-with-a-temporary-password
```

The password must be at least 12 characters. Sign in once, replace the password in the dashboard, and remove `PASEO_BOOTSTRAP_OWNER_PASSWORD`. Hub keeps the account and organization.

## Docker Compose

The Hub repository includes a Compose stack for Hub and PostgreSQL:

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp .env.example .env
docker compose up -d
```

Open <http://localhost:3000> and complete browser setup. For a public deployment, set `PASEO_HUB_APP_URL` and any reverse-proxy settings in `.env` before starting the stack.

The stack publishes Hub on port `3000` and stores PostgreSQL data in a named volume. The published container image is `ghcr.io/getpaseo/hub:latest`.

### HTTPS with Caddy

Compose serves plain HTTP on port `3000`. Run Caddy on the same host to terminate TLS:

```caddyfile
hub.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

Point `hub.example.com` at the host and open ports `80` and `443`. Caddy [obtains and renews the certificate](https://caddyserver.com/docs/automatic-https).

Set these values in `.env`:

```dotenv
PASEO_HUB_APP_URL=https://hub.example.com
PASEO_HUB_TRUSTED_CLIENT_IP_HEADER=x-forwarded-for
```

To keep port `3000` off the public interface, change the `hub` port in `compose.yml` to `"127.0.0.1:3000:3000"`.

## Fly

Clone the repository and copy the example configuration:

```sh
git clone https://github.com/getpaseo/hub.git
cd hub
cp fly.example.toml fly.toml
```

In `fly.toml`, set `app` to your Fly app name, such as `your-hub`. Set `primary_region` to your Fly region. Under `[env]`, set `PASEO_HUB_APP_URL` to your public Hub URL, such as `https://your-hub.fly.dev`.

Create the app and attach a PostgreSQL database using the same app name:

```sh
fly apps create your-hub
fly postgres create --name your-hub-db
fly postgres attach your-hub-db -a your-hub
```

Deploy with your `fly.toml`:

```sh
fly deploy
```

Open the Fly URL and complete browser setup, or set the [bootstrap environment](#bootstrap-from-environment) before deploying.

Keep one machine running continuously. Hub holds Slack Socket Mode and Discord gateway connections, runs the schedule clock, and dispatches events to daemons, so a stopped machine misses events.

## Upgrades

Pull the new image or source and deploy it. Database migrations are forward-only. Back up the embedded data directory or PostgreSQL database before upgrading because it holds accounts, app credentials, triggers, integrations, and execution history.
