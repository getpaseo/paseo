---
title: Getting started
description: Learn how to set up and use Paseo to manage your coding agents from anywhere.
nav: Getting started
order: 1
---

# Getting started

Paseo has three main pieces: the daemon is the local server that manages your agents, the app is the client you use from mobile, web, or desktop, and the CLI is the terminal interface that can also launch the daemon.

## Prerequisites

Paseo manages existing agent CLIs. Install at least one agent and make sure it already works with your credentials before you set up Paseo.

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- [Codex](https://github.com/openai/codex)
- [OpenCode](https://github.com/anomalyco/opencode)

## Desktop App

Download the desktop app from [paseo.sh/download](https://paseo.sh/download) or the [GitHub releases page](https://github.com/getpaseo/paseo/releases). Open it and you're done.

The desktop app bundles and manages its own daemon automatically, so you do not need a separate CLI install on that machine unless you want it.

On first launch, you may briefly see a startup screen while the local server starts and the app connects to it. After that, connect from your phone by scanning the QR code in Settings if you want mobile access.

## CLI / Server

Use this path for headless setups, servers, or remote machines where you want the daemon running without the desktop app.

```bash
npm install -g @getpaseo/cli
```

```bash
paseo
```

Paseo prints a QR code in the terminal. Scan it from the mobile app, or enter the daemon address manually from another client.

Configuration and local state live under `PASEO_HOME`.

## Voice Setup

Paseo includes first-class voice support with a local-first architecture and configurable speech providers.

For architecture, local model behavior, and provider configuration, see the Voice docs page.

[Voice docs](/docs/voice)

## Next

- [Updates](/docs/updates)
- [Voice](/docs/voice)
- [Providers](/docs/providers)
- [Configuration](/docs/configuration)
- [Security](/docs/security)
