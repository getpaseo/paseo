---
title: fx
description: Install and add fx for Paseo.
nav: fx
order: 26
category: Providers
---

# fx

Paseo runs fx, the coding agent from Vercel Labs, through the Agent Client Protocol (`fx acp`) on your installed `fx` CLI. It uses your existing fx credentials and settings.

## Getting started

Add fx from Settings in Paseo before you start an agent.

1. [Install fx](https://fx.sh/docs/getting-started/installation) on your daemon host.
2. [Connect fx to a model provider](https://fx.sh/docs/getting-started/authentication), such as with `fx login`.
3. In Paseo, open **Settings → Hosts → your host → Providers**, select **+ Provider**, find **fx**, and select **Add**.

Until fx has credentials, Paseo shows the sign-in message from fx. If `fx` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary) and keep `acp` in the arguments.

## Models and permissions

The model list comes from the active model provider in fx. Run `fx provider` to change the list that new agents start from.

When you change an agent's permission mode in Paseo, fx also updates its saved permission mode.

See [fx's ACP guide](https://fx.sh/docs/using-fx/acp) for supported features.
