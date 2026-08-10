---
title: Slack triggers
description: Configure Slack mentions and thread replies in one workflow file.
nav: Slack
order: 68
category: Hub
---

# Slack triggers

`slack.mention` fires when the bot is mentioned in a channel where it is present. Direct messages, slash commands, and interactive components do not produce this trigger.

`.paseo/workflows/slack-help.yml`:

```yaml
name: slack-help
on: slack.mention
max_runtime: 1h
filters:
  workspace: T01234567
  channels: [C01234567]
  from_users: [U01234567]
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
      - { type: slack.reply, max: 1, required: true }
```

Slack filters use IDs, not display names. `from_users` matches the author, `workspace` the team, and `channels` the channel. `pattern` is a required prefix after the mention; `contains` is its legacy alias and has the same prefix behavior. All filters must pass.

The reply posts in the triggering thread. A root message gets a thread; a threaded message stays there. `slack.reply` grants `hub.reply`, but does not add reply instructions to the prompt.

Leading declared inputs follow the mention:

```text
@Paseo repo=project agent=claude investigate the failed sync
```

Hub consumes consecutive declared headers and exposes the remainder as `${{ paseo.prompt }}`. See [Workflows](/docs/hub/workflows).
