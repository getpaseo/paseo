---
title: Providers
description: How Paseo thinks about coding agents, wrapping existing CLIs, native vs ACP support, and where to go next.
nav: Providers
order: 3
---

# Providers

Paseo doesn't ship its own coding agent. It launches and supervises **existing CLIs you've already installed and authenticated**, Claude Code, Codex, OpenCode, Cursor, Gemini, and the rest. Your subscriptions, your config, your skills, your MCP servers all stay intact. Paseo just gives you a UI, a CLI, a relay, and orchestration on top.

## Mental model

A provider is the contract between Paseo and one external agent CLI: how to launch it, how to stream its output, how to send input back, what modes it supports. The actual binary lives on your machine and runs as a normal subprocess.

## Two tiers

- **Native support**, Paseo ships a bundled adapter for the major agents (Claude Code, Codex, OpenCode, pi). Auto-discovered when the underlying CLI is installed, with mode metadata and voice support where applicable.
- **ACP catalog**, any agent speaking the [Agent Client Protocol](https://agentclientprotocol.com) is supported through a generic adapter. Paseo ships a curated catalog of one-click installs (Cursor, Gemini, GitHub Copilot, Hermes, Kimi, Qwen Code, and 25+ more), and you can add any other ACP agent yourself.

Either way, **you install the underlying CLI**. Paseo runs it.

## Where to go next

- [Supported providers](/docs/supported-providers), the full list with install links.
- [Custom providers](/docs/custom-providers), add your own provider, point an existing one at a different endpoint, run multiple profiles, or override the binary in `~/.paseo/config.json`.
- [paseo.sh/agents](/agents), per-agent landing page for each supported provider.
