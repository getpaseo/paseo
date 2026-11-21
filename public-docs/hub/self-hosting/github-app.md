---
title: GitHub for Hub
description: Create the GitHub App your self-hosted Hub uses for repository access and event triggers.
nav: GitHub App
order: 78
category: Hub
---

# GitHub for Hub

A self-hosted Hub talks to GitHub through a GitHub App you create and own. One App serves the Hub instance, and each account or organization that installs it becomes a connection under **Integrations**.

Open **Apps → GitHub**. Hub shows the exact callback URLs, required repository permissions, subscribed events, and fields to copy back from GitHub. Hub verifies the App before saving it.

## Public URL requirements

Repository access and App installation work without a webhook. GitHub event triggers require a [public HTTPS address](/docs/hub/self-hosting#public-addresses) so GitHub can deliver webhooks.

On a local HTTP Hub, **Apps → GitHub** lets you configure repository access and marks event webhooks unavailable. Reopen Hub at its public HTTPS origin after setting `PASEO_HUB_APP_URL` to add the webhook secret and events.

GitHub calls these Hub URLs:

| Setting      | Hub URL                                                |
| ------------ | ------------------------------------------------------ |
| Homepage URL | `<PASEO_HUB_APP_URL>`                                  |
| Callback URL | `<PASEO_HUB_APP_URL>/api/integrations/github/callback` |
| Setup URL    | `<PASEO_HUB_APP_URL>/api/integrations/github/setup`    |
| Webhook URL  | `<PASEO_HUB_APP_URL>/webhook`                          |

Keep GitHub SSL verification enabled.

## Subscribe to GitHub events

Under **Subscribe to events**, select **Issue comment**, **Issues**, **Pull requests**, **Pull request review**, **Pull request review comment**, and **Push**. **Pull requests** is required for `github.pull_request_created`, `github.pull_request_ready_for_review`, `github.pull_request_synchronized`, and `github.pull_request_label_added`.

## Connect repositories

After Hub verifies the App, choose **Connect GitHub** and select the account or organization and repositories the App can access. Start the installation from Hub rather than GitHub so the round trip binds the installation to the active Hub organization.

The connection appears under **Integrations** with a slug derived from the account name, such as `acme-github`. You can connect multiple GitHub installations to one Hub organization.

A connected GitHub installation provides two things:

- Event triggers for issues, pull requests, comments, reviews, and pushes. See [GitHub triggers](/docs/hub/triggers/github).
- Scoped installation tokens for triggers that declare a [`run.github` block](/docs/hub/github).

An authenticated `gh` CLI on your daemon does not configure Hub's GitHub integration.

## Configure from environment

Deployments that keep app secrets outside Hub can set these environment variables:

```dotenv
GITHUB_APP_ID=
GITHUB_APP_SLUG=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=
```

`GITHUB_APP_PRIVATE_KEY` holds the downloaded PEM contents. Use `GITHUB_APP_PRIVATE_KEY_PATH` instead when your deployment mounts the PEM file.

Environment configuration takes precedence over a saved GitHub App and appears as **Managed by environment** under **Apps**. Because it includes `GITHUB_WEBHOOK_SECRET`, it expects a public HTTPS origin.
