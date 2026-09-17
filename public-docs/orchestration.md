---
title: Orchestration
description: Coordinate agents across providers and machines, delegate work, and keep tasks moving with schedules and heartbeats.
nav: Overview
order: 30
category: Orchestration
---

# Orchestration

Paseo lets your coding agents coordinate other agents, split work across providers and machines, and keep tasks moving automatically.

## What your agents can do

- **Choose providers and models:** launch other agents using any provider and model configured on the host.
- **Delegate and parallelize:** split research, implementation, and review between agents, including agents from different providers.
- **Communicate with each other:** agents can [send prompts to other agents by ID](/docs/orchestration-workflows#send-a-prompt-to-another-agent) to ask questions, share findings, or request work.
- **Coordinate ongoing work:** check progress, stop tasks, and collect results.
- **Create workspaces and worktrees:** give independent changes their own [working directories](/docs/worktrees).
- **Work across machines:** use the [CLI](/docs/cli#connecting-to-a-remote-daemon) to launch and manage agents on another reachable Paseo host.
- **Choose by specialty:** use [agent profiles](/docs/agent-profiles) and their notes to select settings for UI work, planning, or reviews.
- **Create schedules:** run a prompt in a new agent at [specified times](/docs/schedules).
- **Create heartbeats:** prompt the same agent periodically to [continue its task](/docs/orchestration-workflows#keep-an-agent-working-with-a-heartbeat).

## Get started

Use built-in Paseo tools or the CLI. Both let an agent launch and coordinate workers.

### Built-in Paseo tools (MCP)

Enable Paseo tools so agents running inside Paseo can manage agents and workspaces on their host directly.

1. Open **Settings → your host → Agents**.
2. Turn on **Enable Paseo tools**. Tool injection is off by default.
3. Start a new agent, or reload an existing agent so it receives the tools.
4. Ask:

> Use Paseo to launch a second agent to review this branch. Have it report potential bugs without changing files, then summarize its findings.

The worker appears in the **Subagents track** near the composer. Open it to follow the conversation. Your main agent receives a notification when the worker finishes, and you can keep talking while it works.

See the [MCP reference](/docs/mcp) for tool configuration and the full catalog. [Orchestration skills](/docs/skills) are optional reusable workflows.

### CLI

Agents with shell access can also use the Paseo CLI. This route does not require enabling tool injection. With Paseo installed, a running host, and Codex configured:

```bash
paseo run --provider codex --background \
  "Review this branch without changing files"
paseo ls -a
```

The first command starts a worker and returns immediately; the second lists agents from active workspaces, including archived agents. When a Paseo agent runs the command, the worker becomes its subagent in the same workspace. From your own terminal, it starts in a new local workspace.

See the [CLI reference](/docs/cli) for follow-ups, output, worktrees, and remote hosts.

## Pick settings once with profiles

Save a provider, model, thinking level, mode, and available feature settings as an **agent profile**, then select it in one click when creating an agent.

Add **When to use** notes so an orchestrating agent can choose a profile for the task: UI work, planning, or independent review. [Create profiles and write delegation notes](/docs/agent-profiles).

## Go further

- [Delegate implementation and get an independent review](/docs/orchestration-workflows#implement-then-review).
- [Run parallel changes in separate worktrees](/docs/orchestration-workflows#parallelize-edits-without-collisions).
- [Coordinate work on another machine](/docs/orchestration-workflows#work-on-another-machine).
- [Create recurring jobs](/docs/schedules) or [continue a task with a heartbeat](/docs/orchestration-workflows#keep-an-agent-working-with-a-heartbeat).
- [Install reusable orchestration skills](/docs/skills).
