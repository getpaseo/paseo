---
title: Schedules
description: Run fresh agents on cron schedules or wake an existing agent with a heartbeat.
nav: Overview
order: 25
category: Schedules
---

# Schedules

A schedule starts a new agent for you on a cron cadence: at this time, run this prompt, in this repo, with these agent settings.

Paseo also has **heartbeats**. A heartbeat sends a recurring prompt back into one existing agent so it can reassess and continue the same conversation.

Both concepts use the same cron engine, but their product surfaces stay separate:

- **Schedules** create a new agent each run. You can inspect, pause, resume, run once, update, or delete them.
- **Heartbeats** target one existing agent. They are intentionally lightweight: create or delete them over MCP; from the CLI you can also update only their cron period.

Cron is the canonical cadence. The CLI accepts simple presets such as `5m` or `1h`, but compiles them to cron rather than storing a separate interval type.

Both run on a cadence you set. To start an agent from an external event instead — a comment, a mention — see [Hub](/docs/hub).

## What it's for

- **Fresh recurring jobs:** start a clean agent for daily triage, reports, or maintenance.
- **Heartbeats:** have the current agent periodically reassess state and keep moving.
- **Build babysitting:** keep one agent checking CI, EAS, Docker, or release builds until they pass.
- **Daily triage:** scan issues, PRs, and failing checks every morning.
- **Maintenance sweeps:** refresh dependencies, audit docs, or clean stale branches.

## Run in one workspace

By default every run creates its own workspace. A schedule can instead run in a [workspace](/docs/workspaces) you already have, so each run starts a new agent there and the results collect in one place.

In the app, choose the project, then pick a workspace in the **Workspace** field. **New workspace each run** is the default. From the CLI, pass `--workspace`; see [Schedules from the CLI](/docs/schedules-cli#run-in-a-workspace). Over MCP, pass `workspaceId`.

To get an empty workspace for a schedule, create one without starting an agent: choose **New workspace** in the app, leave the message empty, and create it, or run `paseo workspace create`. Rename it in the sidebar so you can tell it apart in the Workspace field.

A schedule that runs in a workspace behaves differently from one that creates its own:

- It uses the workspace's directory as it is, so worktree isolation doesn't apply.
- **Archive on finish** archives only the run's agent; the workspace stays. The app turns it off by default for these schedules; schedules created from the CLI or over MCP archive each run. An archived agent isn't open as a tab, but you can find it in **History**, open it, and unarchive it.
- Pick a regular workspace, not a background one. History doesn't list agents in background workspaces, so archived runs would be hard to find.
- If the workspace is archived or removed, the schedule shows **Target gone**. Before the next run comes due, choose another workspace in the schedule's form. For an archived workspace you can also restore it: open one of the schedule's earlier runs from **History** and choose **Restore** (**Unarchive** for a workspace that is the project directory itself). Either way the schedule returns to **Active**. A run that comes due while the workspace is still gone ends the schedule, and editing can't bring an ended schedule back, so create it again.

## Ways to create one

- **In the app** — open the Schedules view and create one with agent settings, a cron cadence, a repo, and a prompt. This is the main way to create and manage schedules.
- **[From chat](/docs/schedules-chat)** — ask the agent in a chat and it sets the schedule up for you.
- **[From the CLI](/docs/schedules-cli)** — `paseo schedule create`, for headless boxes and scripts.
- **[Over MCP](/docs/mcp)** — agents create and manage schedules programmatically.
