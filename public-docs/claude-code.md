---
title: Claude Code
description: Run Claude Code in Paseo using your existing Claude plan.
nav: Claude Code
order: 23
category: Providers
---

# Claude Code

Paseo runs Claude Code through the official `claude` CLI using the Claude Agent SDK.

## Does Claude Code cost extra in Paseo?

No. Claude Code usage in Paseo counts against your normal Claude plan limits. It does not require a separate pool of Agent SDK credits.

You still need a Claude plan that includes Claude Code, and your plan's usual usage limits apply.

## Getting started

Install and sign in to the Claude Code CLI on the machine running Paseo. Paseo uses that existing installation and account when you start a Claude Code agent.

If your Claude login expires, re-authenticate with the Claude Code CLI, then start a new Claude Code session in Paseo. Existing Paseo sessions keep the authentication they started with, so re-authenticating does not update a session that is already running.

## Use Claude Code in the Paseo terminal

Claude Code also works great inside the Paseo terminal. If you prefer the standard CLI experience, open a terminal in your workspace and run `claude` as usual.

You can use the terminal from Paseo's desktop, web, or mobile app while keeping access to your workspace, git changes, and other Paseo tools.

## Release idle Claude processes

By default, an idle Claude agent keeps its Claude Code process and its MCP servers running until
you archive it or restart the daemon. To release idle processes, add this to
`$PASEO_HOME/config.json`:

```json
{
  "agents": {
    "claudeIdleBackendTimeoutMs": 1800000
  }
}
```

The value is in milliseconds (minimum 60,000). `0` keeps processes resident. The agent stays in Paseo
as `closed`, not archived. Opening or prompting it later resumes the same agent and Claude session;
the next response has a cold-start delay. Paseo keeps the process while Claude reports background
work (background shells, `Monitor` watches, workflows, background subagents) or a pending
permission. Detached commands that Claude does not track may still be interrupted. A daemon restart
is required after changing this setting.

## See also

- [Supported providers](/docs/supported-providers), for other agents you can run alongside Claude Code.
- [Custom providers](/docs/custom-providers), for custom binaries, third-party endpoints, or multiple Claude profiles.
- [Paseo vs Claude Desktop](/alternatives/claude-desktop), for a feature comparison.
