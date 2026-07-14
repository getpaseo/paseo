---
title: Orchestration
description: Give any coding agent control of Paseo so it can launch and coordinate agents from other providers.
nav: Overview
order: 30
category: Orchestration
---

# Orchestration

Paseo orchestration gives a coding agent control of the Paseo daemon. The agent can discover every provider and model you have configured, create worktrees, launch other agents, send them follow-ups, and create heartbeats or schedules. The same work stays visible in the Paseo app.

## Native subagents vs Paseo subagents

The most important difference from native subagents is that **Paseo subagents can cross provider boundaries**.

```text
Claude Code (Fable 5) => Codex (GPT-5.6)
Codex (GPT-5.6) => Grok Build
Cursor => Claude Code (Fable 5)
```

Native subagents belong to one provider. Claude Code launches Claude Code subagents; Codex launches Codex subagents. They are useful when the parent provider can handle the whole task itself.

Paseo subagents are full agents managed by the Paseo daemon. The orchestrator can choose any configured provider and model, place the worker in the current workspace or a new worktree, and keep coordinating it after launch. Use them when you want one model to plan, another to implement, and another to review.

|                      | Native subagent                           | Paseo subagent                                     |
| -------------------- | ----------------------------------------- | -------------------------------------------------- |
| Provider             | Same provider as its parent               | Any provider configured in Paseo                   |
| Working directory    | Managed by the parent provider            | Current workspace, existing workspace, or worktree |
| Lifecycle            | Owned by the parent provider              | Managed by Paseo; can receive follow-ups or detach |
| Where you inspect it | Read-only timeline in the Subagents track | Full agent session in the Subagents track          |
| Best for             | Fast, provider-native delegation          | Cross-provider work and explicit workspace control |

## Try it

Open **Settings → your host → Agents**, then turn on **Enable Paseo tools**. Start a new agent, or reload an existing one so it receives the tools.

Then ask naturally:

```text
Stay as the orchestrator. Use Paseo to find my available Codex models, then
launch a GPT-5.6 subagent in a new worktree. Ask it to implement the parser
change, run the focused tests, and report back here.
```

The orchestrator discovers the provider and model IDs, starts the worker, and receives a notification when it finishes. You can keep talking to the orchestrator in the meantime.

## Where the work appears

Spawned work appears in the **Subagents track** above the composer. Open a row to read the live conversation.

Both kinds of subagent appear there:

- **Paseo subagents** open as full agent sessions. You can talk to them directly, change their settings, detach them, or archive them.
- **Native provider subagents** open as read-only timelines. You can inspect their work, but their provider owns their lifecycle.

If an agent says background work is running but the track is empty, update Paseo. Provider-created subagent timelines require Paseo 0.1.107 or newer.

## Keep an agent working with a heartbeat

A heartbeat sends a prompt back into the same agent on a cadence. Use one when the agent should keep reassessing a live task: continue a refactor, babysit CI, watch a deployment, or retry after an external system changes.

Ask the agent directly:

```text
Use Paseo to create a heartbeat every 10 minutes. Keep checking this PR, fix any
new CI failures, and stop when all checks pass or after two hours.
```

The base [`/paseo` orchestration skill](/docs/skills) teaches agents how to create heartbeats, so you only need to ask. A heartbeat continues the current conversation; a [schedule](/docs/schedules) is better for standalone cron-style jobs such as daily triage.

You do not need to name MCP tools in your prompts. Ask for the workflow; the agent uses the tools underneath.

Continue with [Common workflows](/docs/orchestration-workflows) for copyable prompts, [Orchestration skills](/docs/skills) for packaged workflows, or the [MCP reference](/docs/mcp) for the complete tool catalog.
