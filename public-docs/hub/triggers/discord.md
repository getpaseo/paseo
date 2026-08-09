---
title: Discord triggers
description: Configure Discord mentions as Hub triggers and route them into durable workflows.
nav: Discord
order: 67
category: Hub
---

# Discord triggers

## Events

| `on`              | Fires when                                                                     |
| ----------------- | ------------------------------------------------------------------------------ |
| `discord.mention` | The bot or one of its managed roles is mentioned in a guild channel or thread. |

## Filters

Discord filters use quoted snowflake IDs:

```yaml
filters:
  guild: "123456789012345678"
  channels: ["234567890123456789"]
  from_users: ["345678901234567890"]
```

Turn on Developer Mode to copy IDs. `from_users` matches the author's user id, `guild` matches the connected guild, and `channels` matches the channel or thread parent. `pattern` matches the start of the text after the mention. All filters must pass.

## Invocation

Put leading inputs directly after the mention:

```text
@Paseo repo=project investigate the failed sync
```

Hub consumes only declared consecutive headers and passes `investigate the failed sync` as `${{ paseo.prompt }}`. See [Hub workflows](/docs/hub/workflows) for the provider-neutral input contract.

## Replies and repository access

Put the reply capability on a step:

```yaml
allow_outputs:
  - type: discord.reply
    max: 5
```

The reply is posted in the triggering thread or channel. The declaration grants the `hub.reply` tool; the prompt has to tell the agent to call it. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).

A Discord trigger has no implicit GitHub credential. If a step needs another connection, configure that connection through the supported step environment for your deployment; Hub does not guess between GitHub installations.

See the [workflow examples](/docs/hub/configuration/examples) for complete step configurations.
