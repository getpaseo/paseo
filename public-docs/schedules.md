---
title: Schedules
description: Run Paseo agents on intervals or cron.
nav: Schedules
order: 8
---

# Schedules

Schedules let agents come back later.

Think of a schedule as a standing instruction: at this cadence, run this prompt, in this repo, with this agent target.

The target can be:

- A new agent each time, useful for fresh daily jobs and long-running watchers.
- An existing agent, useful when you want continuity.
- The same agent that created the schedule, useful for heartbeats from inside an agent.

Schedules can use interval cadence, like every 30 minutes, or cron cadence, like every weekday morning. Runs are recorded, can be inspected later, and can be paused, resumed, triggered once, updated, or deleted.

## Uses

- **Overnight refactoring loops:** wake an agent every 30 minutes to continue a scoped refactor, run checks, and leave notes.
- **Heartbeats:** have the same agent periodically reassess state and keep moving.
- **Long build babysitting:** check CI, EAS, Docker, or release builds until they pass.
- **Daily GitHub triage:** scan issues, PRs, notifications, and flaky checks every morning.
- **Maintenance sweeps:** refresh dependencies, audit docs, clean stale branches, or summarize repo health.

## Setup Examples

Overnight refactor on Codex:

```bash
paseo schedule create \
  --every 30m \
  --name overnight-refactor \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  --max-runs 16 \
  --expires-in 10h \
  "Continue the refactor. Run the focused checks. Leave a short status note."
```

Long build babysitter on Claude:

```bash
paseo schedule create \
  --every 5m \
  --name build-watch \
  --provider claude/opus-4.7 \
  --cwd ~/dev/my-app \
  --max-runs 24 \
  "Check the release build. If it failed, inspect logs, fix the cause, and rerun."
```

Daily GitHub triage on GLM through OpenCode:

```bash
paseo schedule create \
  --cron "0 14 * * 1-5" \
  --run-now \
  --name github-triage \
  --provider opencode/openrouter/glm-5.1 \
  --cwd ~/dev/my-app \
  "Triage GitHub issues, PRs, and failing checks. Summarize what needs attention."
```

Heartbeat the current agent:

```bash
paseo schedule create \
  --every 20m \
  --target self \
  --name heartbeat \
  "Check the current task state and continue with the next useful step."
```

## Managing Schedules

```bash
paseo schedule ls
paseo schedule inspect <id>
paseo schedule logs <id>
paseo schedule pause <id>
paseo schedule resume <id>
paseo schedule run-once <id>
paseo schedule update <id> --every 10m --max-runs 6
paseo schedule delete <id>
```

Use `--every <duration>` for intervals and `--cron "<expr>"` for 5-field UTC cron. Interval schedules run once immediately by default; pass `--no-run-now` to wait for the first interval. Cron schedules wait for the next matching time; pass `--run-now` to fire once immediately.

When targeting a remote daemon with `--host`, pass `--cwd`; your local working directory may not exist on the remote machine.

## MCP

Agents can create and manage schedules through [Paseo MCP](/docs/mcp).
