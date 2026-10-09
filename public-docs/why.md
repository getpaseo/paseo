---
title: Why Paseo?
description: A full agentic development environment for running coding agents, editing files, reviewing changes, and testing your work.
nav: Why Paseo?
order: 2
category: Getting started
---

# Why Paseo?

Paseo is a full agentic development environment. Run coding agents, edit files, review diffs and pull requests, and test your app with terminals and a built-in desktop browser. For agent-driven development, Paseo replaces your IDE: take a task from the first prompt through review and testing in one app.

## Develop in one workspace

Open the desktop app, choose a project and an agent, and start working. Keep the conversation, editor, terminal, diffs, and browser together in split panes. Run your app, inspect the result, and ask the agent for changes without leaving the workspace.

The desktop app is available on macOS, Windows, and Linux. It starts and manages its local daemon automatically.

## Run tasks in parallel

Give independent tasks their own worktrees and branches. Run several agents at once, inspect each diff, test each implementation, and choose what to merge. Use the same provider for every task or choose a different provider and model for each.

Configure [workspace scripts](/docs/worktrees#scripts-and-services) to start development servers with separate ports for each worktree. [Try the parallel development workflow](/docs/parallel-development).

## Use your agents and tools

Paseo runs the coding agents you already use, with your subscriptions, credentials, configuration, skills, and MCP servers. Your agents work with the files and tools on your machine. See [supported providers](/docs/supported-providers).

Dictate tasks or use [voice mode](/docs/voice). Speech-to-text and text-to-speech run locally by default, with cloud providers available in settings.

## Continue from another device

The daemon owns the running agents and workspaces. The desktop app connects to it locally; mobile, web, and CLI clients connect to the same environment. That separation lets you continue working from another device or run your environment on a server.

Use Paseo entirely on your laptop, or connect to another machine when you need it. The native iOS and Android app gives you agents, files, terminals, and diffs on your phone. The built-in browser runs in the desktop app. [Connect your devices](/docs/connectivity) directly or through the optional end-to-end encrypted relay.

## Automate and extend your workflow

Give agents [Paseo tools](/docs/orchestration) to create worktrees, launch other agents, send prompts, and collect results. Use the [CLI](/docs/cli) or [TypeScript SDK](/docs/sdk) to automate agent and workspace operations.

[Plugins](/docs/plugins) add providers, workspace panels, commands, and workflows. [Hub](/docs/hub) connects external events to agents running on your machines.

Paseo is open source under Apache-2.0, with no telemetry, tracking, or required Paseo account.
