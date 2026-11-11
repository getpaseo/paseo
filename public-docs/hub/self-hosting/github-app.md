---
title: GitHub for Hub
description: Create the GitHub App your Hub uses for repository access and event triggers.
nav: GitHub App
order: 75
category: Hub
---

# GitHub for Hub

Hub talks to GitHub through a GitHub App you create and own. One App serves the Hub; each account or organization that installs it becomes a connection.

Open **Apps → GitHub**. Hub gives you the current callback URLs, required repository permissions, subscribed events, and the fields to copy back from GitHub. It verifies the App before saving it.

## Public URL requirements

Repository access and installation work without a GitHub webhook. GitHub event triggers and configuration sync do not: GitHub must be able to deliver events to a public HTTPS URL.

On a local HTTP Hub, the Apps guide lets you configure repository access and explains that event setup is unavailable. Reopen Hub at its public address after setting `PASEO_HUB_APP_URL` to add the webhook secret and events.

GitHub uses these Hub URLs:

| Setting      | Hub URL                                                |
| ------------ | ------------------------------------------------------ |
| Homepage URL | `<PASEO_HUB_APP_URL>`                                  |
| Callback URL | `<PASEO_HUB_APP_URL>/api/integrations/github/callback` |
| Setup URL    | `<PASEO_HUB_APP_URL>/api/integrations/github/setup`    |
| Webhook URL  | `<PASEO_HUB_APP_URL>/webhook`                          |

Keep GitHub's SSL verification enabled.

## Subscribe to GitHub events

Under **Subscribe to events**, select **Issue comment**, **Issues**, **Pull requests**, **Pull request review**, **Pull request review comment**, and **Push**. **Pull requests** is required for `github.pull_request_created` and `github.pull_request_label_added`.

## Connect repositories

After Hub verifies the App, choose **Install on GitHub**. Select the account or organization and repositories the App may access.

Start from Hub rather than GitHub's own install button. The round trip binds the installation to the active Hub organization.

The connection appears with a slug derived from the account. An installation on `getpaseo`, for example, becomes `getpaseo-github`. Connect as many installations as the Hub organization needs.

## What the connection provides

- **Events:** issues, comments, reviews, and pushes from repositories the installation can see. See [GitHub triggers](/docs/hub/triggers/github).
- **Configuration sync:** a repository can hold the canonical `.paseo` bundle. See [Configuration](/docs/hub/configuration).
- **Execution credentials:** Hub mints scoped GitHub App tokens for workflow steps that explicitly request GitHub authority.

An authenticated `gh` CLI on the daemon does not configure Hub's GitHub integration. It can still serve agents outside Hub's scoped GitHub authority, subject to the daemon and provider's own environment and permission policy.

## Configure from environment

Deployments that keep app secrets outside Hub can set:

```dotenv
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
```

The private key is the contents of GitHub's downloaded PEM file. Use `GITHUB_APP_PRIVATE_KEY_PATH` instead when the deployment mounts that file.

Environment configuration takes precedence over a saved GitHub App and appears as **Managed by environment** under **Apps**. A complete environment configuration includes the webhook secret and therefore expects a public webhook origin.
