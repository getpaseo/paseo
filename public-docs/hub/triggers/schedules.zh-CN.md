---
title: 定时触发器
description: 按你的时区在周期性日历计划上运行 Hub Agent。
nav: 定时任务
---

# 定时触发器 {#scheduled-triggers}

定时触发器会按你选择的时区，在周期性日历计划上于你的 daemon 上启动 Agent。结合 [`run.github`](/docs/hub/github) 或[集成工具](/docs/hub/tools)，你可以运行每日 CI 报告、分拣队列或发布检查，并将摘要发送到 Slack 或 Discord。

## 在控制台中创建定时任务 {#create-a-schedule-in-the-dashboard}

在 Hub 中打开 **Triggers**，选择 **New trigger**，并在 **When this happens** 下选择 **Schedule**。选择 **Every minute**、**Every hour**、**Every day** 或 **Every week**，设置本地时间和时区，然后选择 daemon、工作目录和 Agent。

当触发器使用与预设不匹配的自定义 RFC 5545 RRULE 时，表单会显示 **Custom schedule** 字段，并在你编辑其他设置时完整保留该规则。

## 用 YAML 编写定时任务 {#author-a-schedule-in-yaml}

将以下内容保存为 `.paseo/triggers/daily-ci-digest.yml`，并通过 `paseo hub deploy` 部署：

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

`schedule.tick` 不接受 `connection` 或 `filters`。包含 `schedule.tick` 的触发器不能声明 `required: true` 的输入，因为定时触发不会提供调用参数。

设置 `run.background: true` 可以创建后台 Paseo 工作区，使其在默认工作区列表中保持隐藏。设置 `run.auto_archive: true`（默认值）会在运行结束后归档工作区。

## 重复规则 {#recurrence-rules}

`recurrence` 有三个必填字段：

- `start` 是带引号且不含时区偏移的本地日期时间（精确到秒），例如 `"2026-09-09T09:00:00"`。它用于确定间隔对齐并作为起始下限。
- `timezone` 是 IANA 时区名称，例如 `America/New_York` 或 `Europe/Berlin`。
- `rule` 是一条不带 `RRULE:` 前缀的 RFC 5545 RRULE 字符串。

| 频率                   | `rule`                               | 示例 `start`          |
| ---------------------- | ------------------------------------ | --------------------- |
| 每小时                 | `FREQ=HOURLY`                        | `2026-09-09T09:00:00` |
| 每 90 分钟             | `FREQ=MINUTELY;INTERVAL=90`          | `2026-09-09T09:00:00` |
| 每天 09:00 和 17:00    | `FREQ=DAILY;BYHOUR=9,17`             | `2026-09-09T09:00:00` |
| 每隔一周的周一和周五   | `FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR` | `2026-09-07T09:00:00` |
| 每月最后一个周五 17:00 | `FREQ=MONTHLY;BYDAY=-1FR`            | `2026-09-25T17:00:00` |
| 每月最后一天           | `FREQ=MONTHLY;BYMONTHDAY=-1`         | `2026-09-30T09:00:00` |
| 按小时运行 10 次       | `FREQ=HOURLY;COUNT=10`               | `2026-09-09T09:00:00` |

`COUNT` 和 `INTERVAL` 最大支持 `10000`，`rule` 最长支持 `2048` 个字符。`UNTIL` 使用包含端点的 UTC 时间戳，例如 `UNTIL=20261231T235959Z`。

## 触发时机、重叠与恢复 {#timing-overlap-and-recovery}

- Hub 按所选时区的本地挂钟时间计算计划，跳过夏令时跳过的本地时间，并在夏令时回拨重复时仅在较早一次运行。如需跨夏令时保持固定时长间隔，请使用 `UTC`。
- 当该触发器的某次定时运行仍在进行时，Hub 会跳过新到期的触发，不会堆叠并行运行。当前运行完成或失败后，下一次未来触发会恢复。不同触发器仍可在同一台 daemon 上同时运行。
- Hub 停机恢复后，会对最早错过的一次执行派发 1 次补跑，然后直接推进到下一次未来触发，不会逐条重放所有错过的计划。
- 在 `run.prompt` 中包含 `${{ paseo.context }}` 可以传入 `schedule.trigger_id`、`schedule.scheduled_at`（UTC）和 `schedule.timezone`。
- Hub 定时任务独立于 Paseo daemon 本地的定时任务。
