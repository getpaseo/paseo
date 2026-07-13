---
title: Schedules from the CLI
description: Create and manage Paseo schedules with paseo schedule.
nav: CLI
order: 27
category: Schedules
---

# Schedules from the CLI

`paseo schedule` creates and manages [schedules](/docs/schedules) from your terminal, useful for headless boxes and scripts.

## Create

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
  --timezone UTC \
  --run-now \
  --name github-triage \
  --provider opencode/openrouter/glm-5.1 \
  --cwd ~/dev/my-app \
  "Triage GitHub issues, PRs, and failing checks. Summarize what needs attention."
```

Morning triage at 9 AM in New York, including daylight saving time changes:

```bash
paseo schedule create \
  --cron "0 9 * * 1-5" \
  --timezone America/New_York \
  --name morning-triage \
  --provider codex/gpt-5.5 \
  --cwd ~/dev/my-app \
  "Review overnight CI failures and summarize anything urgent."
```

Heartbeat the current agent:

```bash
paseo schedule create \
  --every 20m \
  --target self \
  --name heartbeat \
  "Check the current task state and continue with the next useful step."
```

## Manage

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

## Cadence

Use `--every <duration>` for intervals and `--cron "<expr>"` for 5-field cron. Cron schedules default to UTC. Pass `--timezone <IANA>` to interpret cron fields in a local wall-clock time zone, for example `--timezone America/New_York`. The persisted `nextRunAt` is still a UTC instant, but it is computed from that local time zone so recurring jobs stay at the same local time across daylight saving time changes.

Interval schedules run once immediately by default; pass `--no-run-now` to wait for the first interval. Cron schedules wait for the next matching time; pass `--run-now` to fire once immediately.

When targeting a remote daemon with `--host`, pass `--cwd`; your local working directory may not exist on the remote machine.
