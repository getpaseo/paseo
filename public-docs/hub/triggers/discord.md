---
title: Discord triggers
description: Configure Discord mentions and replies in one workflow file.
nav: Discord
order: 69
category: Hub
---

# Discord triggers

`discord.mention` fires when the bot or a managed role is mentioned in a guild channel or thread.

`.paseo/workflows/discord-help.yml`:

```yaml
name: discord-help
on: discord.mention
max_runtime: 1h
filters:
  guild: "123456789012345678"
  channels: ["234567890123456789"]
  from_users: ["345678901234567890"]
steps:
  - id: answer
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: |
          Answer with hub.reply, then call hub.finish_execution.
          ${{ paseo.prompt }}
    allow_outputs:
      - { type: discord.reply, max: 1, required: true }
```

Turn on Discord Developer Mode to copy IDs. `from_users` matches the author; `guild` and `channels` constrain where the mention arrived. All filters must pass.

The reply posts in the triggering thread or channel. `discord.reply` grants `hub.reply`, but does not rewrite the prompt. A Discord trigger grants no GitHub credential; add a [`github` block](/docs/hub/github) to the step that needs one.

Leading declared inputs follow the mention. Hub exposes the remaining text as `${{ paseo.prompt }}`. See [Workflows](/docs/hub/workflows).
