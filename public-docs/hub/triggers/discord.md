---
title: Discord triggers
description: Discord mentions as Hub triggers, snowflake filters, thread context, and the full paseo.event.discord data reference.
nav: Discord
order: 67
category: Hub
---

# Discord triggers

## Events

| `on`              | Fires when                                        |
| ----------------- | ------------------------------------------------- |
| `discord.mention` | The bot is mentioned in a guild channel or thread |

Mentioning a role the bot holds counts as mentioning the bot.

## Filters

Discord filters take snowflake IDs. Turn on **Developer Mode** in Discord's advanced settings, then right-click a channel or user to copy its ID.

```yaml
filters:
  guild: "123456789012345678"
  channels: ["234567890123456789"]
  from_users: ["345678901234567890"]
```

Quote them. Unquoted snowflakes parse as numbers and lose precision.

- `from_users` matches the author's user id.
- `guild` is resolved to the connection on activation.
- `channels` matches the channel the message was posted in; in a thread, the thread's parent channel counts.
- `pattern` matches the start of the text after the mention.

## Replying

```yaml
allow_outputs:
  - type: discord.reply
```

One plain-text reply per execution, in the triggering thread or channel.

## Repository access

A Discord trigger has no implicit GitHub credential. Name the connection you want:

```yaml
env:
  GH_TOKEN: ${{ paseo.connections.acme-github.token }}
```

Hub will not guess between several GitHub installations.

## Data reference

The triggering message is `paseo.event.discord.trigger_message`:

| Path                 | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| `id`                 | Message snowflake                                     |
| `content`            | Raw text, including the mention                       |
| `body`               | Text with the mention stripped, usually what you want |
| `url`                | Canonical message link                                |
| `author`             | Author identity, including the user id                |
| `channel`            | Channel identity                                      |
| `thread`             | Thread identity, or `null` outside a thread           |
| `created_at`         | Message creation time                                 |
| `attachments`        | Typed list, see below                                 |
| `referenced_message` | Identity of a replied-to message, or `null`           |

Each attachment has `id`, `filename`, `url`, `content_type`, and `size`. A `referenced_message` carries `id`, `channel_id`, and `guild_id`, without the message content.

Also available: `paseo.event.discord.event_type` and `paseo.event.discord.guild.id`.

### Thread context

In a thread, `paseo.event.discord.trigger_thread_context.messages` holds the preceding messages, **oldest first**, never including the triggering message. Each entry exposes the same identity, content, author, channel, creation time, attachment, and reference fields as `trigger_message`.

This is how you give an agent the conversation rather than one line:

```yaml
prompt: |
  Thread so far:
  ${{ paseo.event.discord.trigger_thread_context.messages }}

  Latest request:
  ${{ paseo.event.discord.trigger_message.body }}
```

Outside a thread the list is empty.

## Example

```yaml
triggers:
  - name: discord-fix
    on: discord.mention
    environment: dev
    filters:
      guild: "123456789012345678"
      channels: ["234567890123456789"]
      from_users: ["345678901234567890"]
    agent:
      provider: codex
      mode: full-access
    env:
      GH_TOKEN: ${{ paseo.connections.acme-github.token }}
    allow_outputs:
      - type: discord.reply
    prompt: |
      ${{ paseo.event.discord.trigger_message.body }}

      Context: ${{ paseo.event.discord.trigger_message.url }}
      Reply in the thread when you're done.
```
