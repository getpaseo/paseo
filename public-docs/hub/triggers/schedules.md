---
title: Scheduled triggers
description: Run Hub agents on a recurring calendar schedule in your timezone.
nav: Schedules
order: 69
category: Hub
---

# Scheduled triggers

Scheduled triggers start an agent on your daemon on a recurring calendar schedule in your chosen timezone. Combine them with [`run.github`](/docs/hub/github) or [Integration tools](/docs/hub/tools) to run daily CI reports, triage queues, or release checks and post summaries to Slack or Discord.

## Create a schedule in the dashboard

Open **Triggers** in Hub, choose **New trigger**, and pick **Schedule** under **When this happens**. Choose **Every minute**, **Every hour**, **Every day**, or **Every week**, set the local times and timezone, and pick the daemon, working directory, and agent.

When a trigger uses a custom RFC 5545 RRULE that does not match a preset, the form shows a **Custom schedule** field and preserves the rule when you edit other settings.

## Author a schedule in YAML

Save this as `.paseo/triggers/daily-ci-digest.yml` and deploy with `paseo hub deploy`:

```yaml
name: daily-ci-digest
enabled: true
on:
  schedule.tick:
    recurrence:
      start: "2026-09-09T07:00:00"
      rule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
      timezone: America/New_York
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: new
  max_runtime: 1h
  idle_timeout: 10m
  auto_archive: true
  background: true
  tools:
    slack:
      connection: acme-slack
      actions: [post]
      channels: [C01234567]
  prompt: |
    Analyze the last 24 hours of CI failures, post a short digest to C01234567 with slack_post,
    and call finish_execution.
    Schedule context: ${{ paseo.context }}
```

`schedule.tick` accepts no `connection` or `filters`. A trigger that includes `schedule.tick` cannot declare a `required: true` input because scheduled ticks supply no invocation arguments.

Set `run.background: true` to create a background Paseo workspace that stays hidden from default workspace lists. Set `run.auto_archive: true` (the default) to archive the workspace when the run finishes.

## Recurrence rules

`recurrence` has three required fields:

- `start` is a quoted local date-time with seconds and no offset, such as `"2026-09-09T09:00:00"`. It anchors interval alignment and acts as a lower bound.
- `timezone` is an IANA timezone name, such as `America/New_York` or `Europe/Berlin`.
- `rule` is one RFC 5545 RRULE string without the `RRULE:` prefix.

| Cadence                       | `rule`                               | Example `start`       |
| ----------------------------- | ------------------------------------ | --------------------- |
| Every hour                    | `FREQ=HOURLY`                        | `2026-09-09T09:00:00` |
| Every 90 minutes              | `FREQ=MINUTELY;INTERVAL=90`          | `2026-09-09T09:00:00` |
| Daily at 09:00 and 17:00      | `FREQ=DAILY;BYHOUR=9,17`             | `2026-09-09T09:00:00` |
| Every other Monday and Friday | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR` | `2026-09-07T09:00:00` |
| Last Friday at 17:00          | `FREQ=MONTHLY;BYDAY=-1FR`            | `2026-09-25T17:00:00` |
| Last day of each month        | `FREQ=MONTHLY;BYMONTHDAY=-1`         | `2026-09-30T09:00:00` |
| Ten hourly runs               | `FREQ=HOURLY;COUNT=10`               | `2026-09-09T09:00:00` |

`COUNT` and `INTERVAL` accept values up to `10000`, and `rule` accepts up to `2048` characters. `UNTIL` uses an inclusive UTC timestamp such as `UNTIL=20261231T235959Z`.

## Timing, overlap, and recovery

- Hub evaluates schedules against the selected timezone's local wall clock, skipping times jumped by daylight saving and running repeated times once at their earlier occurrence. Use `UTC` for fixed elapsed-time intervals across daylight saving.
- While a scheduled run is still active, Hub skips newly due occurrences for that trigger instead of stacking parallel runs. Once the active run completes or fails, the next future occurrence resumes. Separate triggers can still run at the same time on the same daemon.
- After Hub downtime, Hub dispatches one catch-up run for the earliest missed occurrence and then advances to the next future occurrence. It does not replay every missed tick.
- Include `${{ paseo.context }}` in `run.prompt` to pass `schedule.trigger_id`, `schedule.scheduled_at` (UTC), and `schedule.timezone`.
- Hub schedules are independent of daemon-native schedules configured in Paseo.
