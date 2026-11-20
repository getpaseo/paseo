---
title: Slack triggers
description: Start Hub agents from Slack channel and thread mentions and reply in thread.
nav: Slack
order: 67
category: Hub
---

# Slack triggers

`slack.mention` fires when someone mentions the bot in a Slack channel or thread where the bot is present. Direct messages, slash commands, and interactive components do not fire this event.

First connect a Slack workspace under **Integrations** (or configure a [Slack app](/docs/hub/self-hosting/slack-app) on a self-hosted Hub) and invite the bot to the channels it watches.

`.paseo/triggers/slack-help.yml`:

```yaml
name: slack-help
on:
  slack.mention:
    connection: acme-slack
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
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
    slack.reply:
      max: 1
      required: true
```

## Filters and prompt text

Slack filters use IDs, not display names or connection slugs. `from_users` is required and matches the sender's Slack member ID. `workspace` matches the Slack team ID and `channels` limits which channels can trigger the run. `pattern` requires a prefix after the mention (`contains` is its legacy alias with the same prefix behavior). All filters compose with AND.

`${{ paseo.prompt }}` contains the complete received message text. If you declare `inputs` on the trigger, Hub parses leading `key=value` tokens after the mention into `${{ paseo.inputs }}`:

```text
@Paseo repo=project investigate the failed sync
```

Include `${{ paseo.context }}` in `run.prompt` to pass the Slack thread history and execution-scoped attachment descriptors as JSON.

## Replies and continuation

Hub posts replies in the triggering Slack thread. A channel message starts a thread, and a reply inside a thread stays in that thread. Follow-up mentions in the same thread continue the same agent by default.

Slack triggers automatically grant the `reply` tool (`slack.reply`). Declare `run.outputs.slack.reply` when you want to cap `max` replies or set `required: true`. When Hub runs over HTTPS, replies include an **Open in Paseo** link.

To read or post to Slack channels from a schedule, webhook, or another trigger, use [Integration tools](/docs/hub/tools). To give the agent repository access, add a [`run.github` block](/docs/hub/github).

## Find your Slack IDs

| Filter       | Where to copy it                                                                           |
| ------------ | ------------------------------------------------------------------------------------------ |
| `workspace`  | Open Slack in a browser. The team ID is the `T...` segment of the URL.                     |
| `from_users` | Open your avatar, then **Profile**, then **⋮**, then **Copy member ID** (starts with `U`). |
| `channels`   | Open the channel name, then **About**. The channel ID is at the bottom (starts with `C`).  |

`paseo hub init` reads the Slack connection automatically and prompts only for your member ID.
