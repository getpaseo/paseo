---
title: GitHub for Hub
description: Create the GitHub App your Hub uses, install it, and connect it to an organization.
nav: GitHub App
order: 75
category: Hub
---

# GitHub for Hub

Hub talks to GitHub through a GitHub App you own. One App serves your whole Hub; each account or organization that installs it becomes a connection.

## Create the App

Go to **Settings → Developer settings → GitHub Apps → New GitHub App** on the account that should own it.

Replace `hub.example.com` with your `PASEO_HUB_APP_URL`.

| Setting            | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| Homepage URL       | `https://hub.example.com`                                  |
| Callback URL       | `https://hub.example.com/api/integrations/github/callback` |
| Setup URL          | `https://hub.example.com/api/integrations/github/setup`    |
| Redirect on update | on                                                         |
| Webhook URL        | `https://hub.example.com/webhook`                          |
| Webhook secret     | a value you generate                                       |

Repository permissions:

| Permission    | Access       | Why                                       |
| ------------- | ------------ | ----------------------------------------- |
| Contents      | Read & write | Read the `.paseo` bundle, let agents push |
| Issues        | Read & write | Read comments, add reactions              |
| Pull requests | Read & write | Read review comments, let agents open PRs |
| Metadata      | Read         | Required by GitHub                        |

Subscribe to events:

- Issue comment
- Issues
- Pull request review
- Pull request review comment
- Push

Push is what makes configuration sync work. Without it, Hub never learns that the `.paseo` bundle changed.

## Configure Hub

From the App's settings page, collect:

| Value                     | Environment variable       |
| ------------------------- | -------------------------- |
| App ID                    | `GITHUB_APP_ID`            |
| The slug in the App's URL | `GITHUB_APP_SLUG`          |
| Client ID                 | `GITHUB_APP_CLIENT_ID`     |
| A generated client secret | `GITHUB_APP_CLIENT_SECRET` |
| A generated private key   | `GITHUB_APP_PRIVATE_KEY`   |
| The webhook secret        | `GITHUB_WEBHOOK_SECRET`    |

The private key downloads as a PEM file. Pass its contents in `GITHUB_APP_PRIVATE_KEY`, or its path in `GITHUB_APP_PRIVATE_KEY_PATH`.

Restart Hub. GitHub should now show as **Ready** in Connections.

## Connect

Open **Connections → GitHub → Connect**. Hub sends you to GitHub to install the App, then binds the installation to your organization.

Start from Hub, not from GitHub's own install button. GitHub only calls the setup URL when an installation is created or changed, so installing directly can leave you on a settings page with nothing bound.

The connection appears with a slug derived from the account: an installation on `getpaseo` becomes `getpaseo-github`. That slug is how configuration names this connection.

Connect as many installations as you need. A personal account and several organizations can coexist in one Hub organization.

## What the connection gives you

- **Events.** Comments, issues, and reviews from every repository the installation can see. See [GitHub triggers](/docs/hub/triggers/github).
- **Configuration sync.** Any repository in the installation can hold the canonical `.paseo` bundle. See [Configuration](/docs/hub/configuration).
- **Tokens.** Scoped, per-execution GitHub credentials.

Which repositories the installation covers is a GitHub setting. Change it on GitHub, not in Paseo.
