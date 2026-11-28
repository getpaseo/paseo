---
title: Claude Code
description: Run Claude Code in Paseo using your existing Claude plan.
nav: Claude Code
order: 24
category: Providers
---

# Claude Code

Paseo runs Claude Code through the official `claude` CLI and the Claude Agent SDK. It uses your local installation and existing Claude account.

## Getting started

Claude Code is built into Paseo and enabled by default.

1. Install the [Claude Code CLI](https://code.claude.com/docs/en/setup#install-claude-code) on your daemon host.
2. Run `claude` in a terminal and sign in.
3. In Paseo, choose **Claude** when you start an agent.

If `claude` is outside your daemon PATH, use a [command override](/docs/custom-providers#custom-binary).

If your Claude login expires, sign in again in the Claude Code CLI and start a new session in Paseo. Running sessions keep the authentication they started with, so signing in again does not update an active session.

## Does Claude Code cost extra in Paseo?

No. Claude Code usage in Paseo counts against your normal Claude plan limits. It does not require a separate pool of Agent SDK credits.

You still need a Claude plan that includes Claude Code, and your plan's normal usage limits apply.

## Use Claude Code in the Paseo terminal

Claude Code also works inside the Paseo terminal. Open a terminal in your workspace and run `claude` for the standard CLI experience.

You can use the terminal from Paseo's desktop, web, or mobile app. You keep access to your workspace, git changes, and other Paseo tools.

## See also

- [Supported providers](/docs/supported-providers), for other agents you can run alongside Claude Code.
- [Custom providers](/docs/custom-providers), for custom binaries, third-party endpoints, or multiple Claude profiles.
- [Paseo vs Claude Desktop](/alternatives/claude-desktop), for a feature comparison.
