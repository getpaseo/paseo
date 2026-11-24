---
title: GitHub Copilot
description: Install the GitHub Copilot CLI and run it in Paseo.
nav: GitHub Copilot
order: 27
category: Providers
---

# GitHub Copilot

Paseo runs GitHub Copilot through the official Agent Client Protocol (`copilot --acp`) on your installed `copilot` CLI. It uses your local CLI and existing GitHub sign-in.

## Getting started

GitHub Copilot is built into Paseo and enabled by default.

1. Install the [GitHub Copilot CLI](https://github.com/features/copilot/cli/) on your daemon host.
2. Run `copilot` in a terminal and sign in to GitHub.
3. In Paseo, choose **Copilot** when you start an agent.

If `copilot` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary) and keep `--acp` in the arguments.

## Modes

**Agent** is the default mode.

| Mode      | Effect                                                             |
| --------- | ------------------------------------------------------------------ |
| Agent     | The default mode for conversational work.                          |
| Plan      | Copilot creates and runs multi-step plans.                         |
| Allow All | Copilot approves every tool, path, and URL request without asking. |
