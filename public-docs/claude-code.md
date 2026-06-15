---
title: Claude Code
description: How Paseo runs Claude Code and how Anthropic's usage policy applies.
nav: Claude Code
order: 23
category: Providers
---

# Claude Code

Paseo runs Claude Code through the official `claude` CLI using the same Claude Agent SDK that Claude Desktop uses internally.

## Anthropic's June 15, 2026 policy change

Starting June 15, 2026, Anthropic splits Claude Code usage into two buckets. This is documented in their official support article: ["Use the Claude Agent SDK with your Claude plan"](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

**Interactive usage** — draws from your main subscription limits:

- Claude Code in your terminal
- Claude Code in VS Code, JetBrains, and other IDEs
- Claude Desktop (Anthropic's own app)
- Claude chat on web, mobile, and desktop

**Programmatic usage** — draws from a separate monthly credit pool:

- `claude -p` (non-interactive/scripting mode)
- Claude Agent SDK usage in your own projects
- Claude Code GitHub Actions integration
- Third-party apps that authenticate through the Agent SDK

Credit amounts per month: Pro ($20), Max 5x ($100), Max 20x ($200), Team Standard ($20/seat), Team Premium ($100/seat). Credits don't roll over. After they run out, additional usage flows to pay-as-you-go API rates (if you have usage credits enabled).

## Where Paseo fits

Paseo uses the **Claude Agent SDK** to run Claude Code — the exact same mechanism Claude Desktop uses under the hood. Claude Desktop is whitelisted by Anthropic and counts as interactive usage. Paseo is not.

Even though the usage is practically interactive — you type prompts, review output, and approve tool calls in real time — Anthropic classifies Paseo as "programmatic usage" because it is a third-party app that authenticates through the Agent SDK.

## What this means for you

- Your **interactive** Claude Code usage (terminal, IDE, Claude Desktop) continues to draw from your main subscription limits, unchanged.
- Your **Paseo chat** usage draws from the separate Agent SDK monthly credits.
- Using Claude Code inside a Paseo terminal draws from your main subscription limits, same as any terminal.

## You can still use the terminal

Paseo has first-class terminal support. You can run Claude Code in your terminal exactly as you always have, and Paseo will still give you:

- **Worktree management** — create and switch git worktrees from the app
- **Remote access** — connect to your daemon from mobile or web while your terminal session runs locally
- **Git diffs** — review changes in a visual diff viewer
- **GitHub integration** — commit, push, open PRs, watch checks, and merge from the app
- **Agent supervision** — see all running agents, send follow-up prompts, and review output history
- **Relay** — access your terminal session from anywhere without exposing your machine

## See also

- [Anthropic: Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
- [Custom providers](/docs/custom-providers), for custom binaries, third-party endpoints, or multiple Claude profiles.
- [Supported providers](/docs/supported-providers), for other agents you can run alongside Claude Code.
- [Paseo vs Claude Desktop](/alternatives/claude-desktop), for a feature comparison.
