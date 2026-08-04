---
title: Slack triggers
description: Slack mentions as Hub triggers, ID-based filters, replies, and the full paseo.event.slack data reference.
nav: Slack
order: 66
category: Hub
---

# Slack triggers

## Events

| `on`            | Fires when                                               |
| --------------- | -------------------------------------------------------- |
| `slack.mention` | The bot is mentioned in a channel it has been invited to |

The bot must be in the channel. `/invite @Paseo` first, or nothing arrives.

## Filters

Slack filters take IDs, never display names. Copy a channel ID from the channel's details; copy a user ID from a member's profile menu.

```yaml
filters:
  workspace: T01234567
  channels: [C01234567]
  from_users: [U01234567]
```

- `from_users` matches the Slack user id of the author.
- `workspace` is the team id, resolved to the connection on activation.
- `channels` matches the channel id the message was posted in.
- `pattern` matches the start of the text **after** the mention, and must end on a word boundary. `contains` is treated the same as `pattern` here.

The mention itself is always required. A message that does not mention the bot never produces an event.

## Replying

```yaml
allow_outputs:
  - type: slack.reply
```

That gives the agent one plain-text reply, posted in the thread. A root message gets a new thread; a threaded message gets a reply in the same thread.

## Data reference

Everything lives under `paseo.event.slack`.

| Path         | Value                             |
| ------------ | --------------------------------- |
| `event_type` | `mention`                         |
| `event_id`   | Slack's Events API event id       |
| `event_ts`   | Event timestamp from the envelope |
| `event_time` | Envelope delivery time            |
| `team`       | Workspace identity                |
| `app`        | The installed app identity        |

The message itself is `paseo.event.slack.trigger_message`:

| Path         | Value                                                 |
| ------------ | ----------------------------------------------------- |
| `ts`         | Native message timestamp, Slack's message id          |
| `content`    | Raw text, including the `<@BOT>` mention              |
| `body`       | Text with the mention stripped, usually what you want |
| `author`     | Author identity, including the user id                |
| `channel`    | Channel identity                                      |
| `thread`     | Thread identity, or `null` for a root message         |
| `created_at` | Derived from the message `ts`                         |

Use `body`, not `content`, unless you specifically need the mention text.

## Example

```yaml
triggers:
  - name: slack-mention
    on: slack.mention
    environment: dev
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    agent:
      provider: codex
      mode: full-access
    idle_timeout: 10m
    allow_outputs:
      - type: slack.reply
    prompt: |
      ${{ paseo.event.slack.trigger_message.body }}

      Reply in the thread when you're done.
```

## Limits

Direct messages, slash commands, and interactive components do not produce triggers. Enterprise Grid org-wide installs are not supported.
