---
title: Why Paseo?
description: What Paseo is, what it isn't, and how it fits into your workflow.
nav: Why Paseo?
order: 2
---

# Why Paseo?

Paseo is a self-hostable platform for running and orchestrating coding agents. It runs the agent CLIs you already use, on the hardware you already have, and gives you a UI, CLI, and API to drive them from anywhere.

## Architecture

- Daemon-client architecture. The daemon manages agents; clients (mobile, desktop, web, CLI) connect locally or over a relay. Remote access isn't an add-on.
- macOS, Windows, and Linux are all primary targets. None of them are a port or an afterthought.
- Mobile, desktop, and web are separate native clients. The mobile app is built in React Native, not a webview.

## Providers

- Bring your own. Use your Claude subscription, your OpenAI account, your own API keys, a self-hosted endpoint. Paseo doesn't proxy model calls.
- Local voice stack. Speech-to-text and text-to-speech run on-device by default. OpenAI providers are configurable if you want cloud quality.
- Open source. No telemetry on your code.

## Where agents run

- Your laptop, a homelab, a company server. Same daemon, same client surface.
- Any directory, git or not. Launch agents, merge locally, review the diff in the app.
- GitHub PRs, checks, and reviews surface in the app when you want them. Not required.

## Parallel work

- Splits and panes. Agents, terminals, and browsers side by side in one workspace.
- Per-worktree services. Each worktree gets allocated ports for dev servers and databases, reachable through proxy URLs like `web.fix-auth.my-app.localhost` so they don't collide.
- Multiple agents on the same repo via worktrees.

## Automation

- The CLI exposes the same surface as the app. Anything in the UI is scriptable.
- MCP server. Agents can drive Paseo themselves: create worktrees, spawn other agents, open terminals, send prompts.

## What it isn't

Not a hosted agent, not an IDE, not a model provider. Paseo runs the CLIs you already use and stays out of the way.
