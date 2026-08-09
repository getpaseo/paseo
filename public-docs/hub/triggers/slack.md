---
title: Slack triggers
description: Configure Slack mentions as Hub triggers and route them into durable workflows.
nav: Slack
order: 66
category: Hub
---

# Slack triggers

## Events

| `on`            | Fires when                                                |
| --------------- | --------------------------------------------------------- |
| `slack.mention` | The bot is mentioned in a channel it has been invited to. |

The mention is required. Direct messages, slash commands, and interactive components do not produce this trigger.

## Filters

Slack filters use IDs, not display names:

```yaml
filters:
  workspace: T01234567
  channels: [C01234567]
  from_users: [U01234567]
  pattern: "repo="
```

`from_users` matches the author's Slack user id. `workspace` is the team id. `channels` matches the channel id. `pattern` (or `contains`) matches the start of the text after the mention. All filters must pass.

## Invocation

Put leading inputs directly after the mention:

```text
@Paseo repo=project agent=claude investigate the failed sync
```

Hub consumes only declared consecutive headers and passes `investigate the failed sync` as `${{ paseo.prompt }}`. See [Hub workflows](/docs/hub/workflows) for input types, defaults, choices, and rejection behavior.

## Replies and workflow shape

Put the reply capability on a step:

```yaml
allow_outputs:
  - type: slack.reply
    max: 5
```

The reply is posted in the triggering thread. A root message gets a new thread; a threaded message stays in that thread. Use the shared [workflow examples](/docs/hub/configuration/examples) for complete configurations.
