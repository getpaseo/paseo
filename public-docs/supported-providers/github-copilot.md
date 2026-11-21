---
title: GitHub Copilot
description: Install the GitHub Copilot CLI and run it in Paseo.
nav: GitHub Copilot
order: 27
category: Providers
---

# GitHub Copilot

Run GitHub Copilot in Paseo with your existing `copilot` CLI and GitHub account.

## Getting started

1. Install the [GitHub Copilot CLI](https://github.com/features/copilot/cli/) on your daemon host.
2. Run `copilot` in a terminal and sign in to GitHub.
3. In Paseo, choose **Copilot** when you start an agent.

Paseo launches `copilot --acp` and uses the sign-in that the CLI already has. If `copilot` is outside your daemon's PATH, use a [command override](/docs/custom-providers#custom-binary) and keep `--acp` in the arguments.

## Modes

**Agent** is the default mode.

| Mode      | Effect                                                        |
| --------- | ------------------------------------------------------------- |
| Agent     | The default mode for conversational work.                     |
| Plan      | Copilot creates multi-step plans and executes them.           |
| Allow All | Copilot approves every tool, path, and URL request by itself. |
