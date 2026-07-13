---
title: Schedules
description: Run Paseo agents on a schedule — every few minutes or on a cron.
nav: Overview
order: 25
category: Schedules
---

# Schedules

A schedule runs an agent for you on a cadence: at this interval or cron time, run this prompt, in this repo, with this agent.

The target can be:

- A new agent each run — fresh daily jobs and long-running watchers.
- An existing agent — when you want continuity.
- The agent that created the schedule — heartbeats from inside an agent.

Cadence is either an interval, like every 30 minutes, or a cron expression, like every weekday morning. Every run is recorded, and you can pause, resume, run once, update, or delete a schedule at any time.

## What it's for

- **Overnight refactors:** wake an agent every 30 minutes to continue a scoped refactor, run checks, and leave notes.
- **Heartbeats:** have an agent periodically reassess state and keep moving.
- **Build babysitting:** check CI, EAS, Docker, or release builds until they pass.
- **Daily triage:** scan issues, PRs, and failing checks every morning.
- **Maintenance sweeps:** refresh dependencies, audit docs, or clean stale branches.

## Ways to create one

- **In the app** — open the Schedules view and create one with an agent, a cadence, a repo, and a prompt. This is the main way to create and manage schedules.
- **[From chat](/docs/schedules-chat)** — ask the agent in a chat and it sets the schedule up for you.
- **[From the CLI](/docs/schedules-cli)** — `paseo schedule create`, for headless boxes and scripts.
- **[Over MCP](/docs/mcp)** — agents create and manage schedules programmatically.
