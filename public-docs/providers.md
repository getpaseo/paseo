---
title: Providers
description: How Paseo thinks about coding agents, wrapping existing CLIs, native support and ACP agents, and where to go next.
nav: Providers
order: 20
category: Providers
---

# Providers

Paseo runs **existing coding agents you've installed and authenticated** in workspaces with an editor, terminals, diffs, and, on desktop, a browser. Run several agents in parallel, choose a provider for each task, and review their work in the same app. Your subscriptions, config, skills, and MCP servers stay intact.

To try the workflow, [run parallel tasks in separate worktrees](/docs/parallel-development).

## Mental model

A provider is the contract between Paseo and one external agent CLI: how to launch it, how to stream its output, how to send input back, what modes it supports. The actual binary lives on your machine and runs as a normal subprocess.

## Native support and ACP agents

- **Native support.** Paseo ships an integration for each of these agents: [Antigravity](/docs/supported-providers/antigravity), [Claude Code](/docs/supported-providers/claude-code), [Codex](/docs/supported-providers/codex), [fx](/docs/supported-providers/fx), [GitHub Copilot](/docs/supported-providers/github-copilot), [Hoplite](/docs/supported-providers/hoplite), [Muse Code](/docs/supported-providers/muse-code), [Oh My Pi](/docs/supported-providers/omp), [OpenCode](/docs/supported-providers/opencode), and [Pi](/docs/supported-providers/pi). Most of them appear in Paseo when the CLI is installed, with mode metadata and voice support where applicable.
- **ACP agents.** Paseo runs any agent that speaks the [Agent Client Protocol](https://agentclientprotocol.com) through a generic adapter. The in-app catalog lists Cursor, Gemini CLI, Hermes, Kimi, Qwen Code, and 30+ more, and you can add any other ACP agent yourself.

Either way, **you install the underlying CLI**. Paseo runs it.

## Where to go next

- [Supported providers](/docs/supported-providers), the full list with install links.
- [Agent profiles](/docs/agent-profiles), save model, mode, and thinking settings together, with notes to guide delegation.
- [Custom providers](/docs/custom-providers), add your own provider, point an existing one at a different endpoint, configure multiple provider aliases, or override the binary in `~/.paseo/config.json`.
- [paseo.sh/agents](/agents), per-agent landing page for each supported provider.
