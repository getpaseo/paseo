---
title: OpenCode
description: Install OpenCode and run it in Paseo.
nav: OpenCode
order: 31
category: Providers
---

# OpenCode

Paseo runs OpenCode through your installed `opencode` CLI. It uses your existing credentials and configuration.

## Getting started

OpenCode is built into Paseo and enabled by default.

1. Install [OpenCode](https://opencode.ai/) on your daemon host:

   ```bash
   npm install -g opencode-ai
   ```

2. Connect OpenCode to a model provider, and make sure that `opencode` runs in a terminal.
3. In Paseo, choose **OpenCode** when you start an agent.

If you use OpenCode v2, install version 2.0.10 or later. Paseo rejects older v2 versions.

If `opencode` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary).

## Modes

Paseo shows OpenCode agents as modes.

| Mode  | Effect                                          |
| ----- | ----------------------------------------------- |
| Build | Allows edits and tool execution.                |
| Plan  | Read-only planning. OpenCode avoids file edits. |

Primary agents that you define in OpenCode appear in the same list.

## See also

- [OpenCode with an existing v2 server](https://github.com/getpaseo/paseo/blob/main/docs/custom-providers.md#opencode-with-an-existing-v2-server) on GitHub, to make Paseo use an OpenCode server that is already running.
- [Provider options](/docs/sdk/provider-options#opencode), to set OpenCode permission rules for agents created from the SDK.
