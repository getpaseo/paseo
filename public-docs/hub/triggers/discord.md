---
title: Discord triggers
description: Start Hub agents from Discord mentions and reply in the channel or thread.
nav: Discord
order: 68
category: Hub
---

# Discord triggers

`discord.mention` fires when someone mentions the bot or its managed role in a Discord server channel or thread.

First connect a Discord server under **Integrations** (or configure a [Discord app](/docs/hub/self-hosting/discord-app) on a self-hosted Hub).

`.paseo/triggers/discord-help.yml`:

```yaml
name: discord-help
on:
  discord.mention:
    connection: acme-discord
    filters:
      guild: "123456789012345678"
      channels: ["234567890123456789"]
      from_users: ["345678901234567890"]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  continuation:
    mode: conversation
  max_runtime: 30m
  idle_timeout: 5m
  prompt: |
    Answer the request using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
  outputs:
    discord.reply:
      max: 1
      required: true
```

## Filters and prompt text

Discord filters use numeric snowflake IDs, not server names, display names, or connection slugs. Quote every snowflake ID so YAML keeps it as a string.

`from_users` is required and matches the sender, while `guild` and `channels` restrict where the mention arrived. `pattern` requires a prefix after the mention (`contains` is its legacy alias with the same prefix behavior). All filters compose with AND.

`${{ paseo.prompt }}` contains the complete received message text. If you declare `inputs`, Hub parses leading `key=value` tokens after the mention into `${{ paseo.inputs }}`. Include `${{ paseo.context }}` in `run.prompt` to pass the referenced message, thread history, and attachment descriptors as JSON.

## Replies and continuation

Hub posts replies in the triggering Discord channel or thread. Follow-up mentions in the same thread continue the same agent by default.

Discord triggers automatically grant the `reply` tool (`discord.reply`). Declare `run.outputs.discord.reply` to enforce `max` or `required: true`. When Hub runs over HTTPS, replies include an **Open in Paseo** link.

To read or post to Discord channels and forums from a schedule, webhook, or another trigger, use [Integration tools](/docs/hub/tools). To give the agent repository access, add a [`run.github` block](/docs/hub/github).

## Find your Discord IDs

In Discord, turn on **Settings → Advanced → Developer Mode**. Right-click a server and choose **Copy Server ID** for `guild`, right-click a channel and choose **Copy Channel ID** for `channels`, and right-click a user and choose **Copy User ID** for `from_users`.

`paseo hub init` selects your connected Discord server automatically and asks for your user ID.
