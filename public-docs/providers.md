---
title: Providers
description: How Paseo thinks about coding agents, wrapping existing CLIs, native vs ACP support, and where to go next.
nav: Providers
order: 20
category: Providers
---

# Providers

Paseo runs **existing coding agents you've installed and authenticated** in workspaces with an editor, terminals, diffs, and, on desktop, a browser. Run several agents in parallel, choose a provider for each task, and review their work in the same app. Your subscriptions, config, skills, and MCP servers stay intact.

To try the workflow, [run parallel tasks in separate worktrees](/docs/parallel-development).

## Mental model

A provider is the contract between Paseo and one external agent CLI: how to launch it, how to stream its output, how to send input back, what modes it supports. The actual binary lives on your machine and runs as a normal subprocess.

## Two tiers

- **Native support**, Paseo ships a bundled adapter for the major agents (Claude Code, Codex, OpenCode, Pi, [Antigravity](/docs/supported-providers#antigravity), [Muse Code](/docs/muse-code)). Auto-discovered when the underlying CLI is installed, with mode metadata and voice support where applicable.
- **ACP catalog**, any agent speaking the [Agent Client Protocol](https://agentclientprotocol.com) is supported through a generic adapter. Paseo ships a curated catalog of one-click installs (Cursor, Gemini, GitHub Copilot, Hermes, Kimi, Qwen Code, and 25+ more), and you can add any other ACP agent yourself.

Either way, **you install the underlying CLI**. Paseo runs it.

## Where to go next

- [Supported providers](/docs/supported-providers), the full list with install links.
- [Agent profiles](/docs/agent-profiles), save model, mode, and thinking settings together, with notes to guide delegation.
- [Custom providers](/docs/custom-providers), add your own provider, point an existing one at a different endpoint, configure multiple provider aliases, or override the binary in `~/.paseo/config.json`.
- [paseo.sh/agents](/agents), per-agent landing page for each supported provider.
