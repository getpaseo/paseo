---
title: fx
description: Install and configure fx for Paseo.
nav: fx
order: 26
category: Providers
---

# fx

Run fx, the coding agent from Vercel Labs, in Paseo with your existing fx installation and credentials.

## Getting started

1. [Install fx](https://fx.sh/docs/getting-started/installation) on your daemon host.
2. [Connect fx to a model provider](https://fx.sh/docs/getting-started/authentication), for example with `fx login`.
3. In Paseo, open **Settings → Hosts → your host → Providers**, select **+ Provider**, find **fx**, and choose **Add**.

Paseo launches `fx acp` and uses your fx credentials and settings. Until fx has credentials, the provider reports the sign-in message from fx.

If `fx` is outside your daemon's PATH, use a [command override](/docs/custom-providers) and keep `acp` in the arguments.

## Models and permissions

The model list comes from the model provider that is active in fx. Run `fx provider` to change the list that a new agent starts from.

Changing an agent's permission mode in Paseo also changes fx's saved permission mode.

See [fx's ACP guide](https://fx.sh/docs/using-fx/acp) for what fx supports.
