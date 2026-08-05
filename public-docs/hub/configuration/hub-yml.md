---
title: hub.yml reference
description: Every field in a Paseo Hub configuration: environments, triggers, filters, outputs, and merge variables.
nav: hub.yml reference
order: 69
category: Hub
---

# `hub.yml` reference

The complete field reference for a Hub configuration. For where the file lives and how it activates, see [Configuration](/docs/hub/configuration).

```text
environments:   where agents run
triggers:       what starts them
```

Both keys are required. `environments` needs at least one entry.

## Environments

An environment says where an agent runs.

```yaml
environments:
  - name: dev
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
```

| Field      | Required | Notes                                                       |
| ---------- | -------- | ----------------------------------------------------------- |
| `name`     | yes      | Referenced by a trigger's `environment`.                    |
| `kind`     | yes      | `daemon`. Only daemon environments run today.               |
| `daemon`   | yes      | The daemon's display name, resolved to an id on activation. |
| `cwd`      | yes      | Absolute path on that machine.                              |
| `worktree` | no       | Run in an isolated git worktree instead of `cwd` directly.  |

### Worktrees

```yaml
worktree:
  mode: branch-off
  newBranch: hub/issue-${{ paseo.event.github.issue.number }}
  base: main
```

Three modes:

| Mode              | Fields                       | Behavior                                   |
| ----------------- | ---------------------------- | ------------------------------------------ |
| `branch-off`      | `newBranch`, optional `base` | New branch off `base`, or the current head |
| `checkout-branch` | `branch`                     | Existing branch                            |
| `checkout-pr`     | `prNumber`                   | The pull request's head                    |

`newBranch`, `base`, and `branch` accept merge variables. `prNumber` does not, because it is a literal number. For a per-event pull request use `checkout-branch` with `${{ paseo.event.github.pull_request.head.ref }}`.

See [Git worktrees](/docs/worktrees) for how the daemon sets them up.

## Triggers

```yaml
triggers:
  - name: review
    on: github.pull_request_review_comment
    environment: dev
    filters:
      repo: acme/api
      contains: "@paseo"
      from_users: [alice, bob]
    agent:
      provider: codex
      mode: full-access
    prompt: ${{ paseo.event.github.comment.body }}
    timeout: 45m
    idle_timeout: 5m
    auto_archive: true
```

| Field           | Required | Default | Notes                                                     |
| --------------- | -------- | ------- | --------------------------------------------------------- |
| `name`          | yes      |         | Unique within the configuration.                          |
| `on`            | yes      |         | `provider.event`, see below.                              |
| `environment`   | yes      |         | An environment `name`.                                    |
| `agent`         | yes      |         | `provider`, `mode`, optional `model`, `thinkingOptionId`. |
| `prompt`        | yes      |         | Supports merge variables.                                 |
| `filters`       | yes      |         | `from_users` is mandatory. See below.                     |
| `env`           | no       |         | Environment variables for the agent process.              |
| `allow_outputs` | no       | none    | Lets the agent reply to the source.                       |
| `timeout`       | no       | `1h`    | Absolute wall clock. Max `24h`.                           |
| `idle_timeout`  | no       | `5m`    | Starts on the first idle report from the daemon.          |
| `auto_archive`  | no       | `false` | Archive the agent when the execution ends.                |

Durations are a positive integer plus `ms`, `s`, `m`, or `h`.

`agent.provider` and `agent.mode` are the same identifiers the Paseo CLI uses, such as `codex`, `claude`, and `full-access`. See [Supported providers](/docs/supported-providers).

## Events and filters

`on` and `filters` decide which events reach a trigger. Both are documented in [Triggers](/docs/hub/triggers), with a page per provider for the events and data each one exposes.

`filters` is required, and `from_users` must be non-empty. Validation rejects a trigger without it.

## Merge variables

`${{ ... }}` expressions are available in `prompt`, `env`, and worktree branch fields. Values reach the agent's process only through `env`; nothing else is injected.

### Event data

`${{ paseo.event.<provider>.<path> }}` exposes the provider's own payload, unflattened. The full field list per provider lives with its trigger page: [GitHub](/docs/hub/triggers/github), [Slack](/docs/hub/triggers/slack), [Discord](/docs/hub/triggers/discord).

Manual runs expose `actor`, `input`, `config`, `trigger`, and `delivery_id` under `paseo.event.manual`.

### Connection credentials

`${{ paseo.connections.<slug>.token }}` mints a token from a named connection. GitHub connections are the only ones that provide a token today.

Use it when a trigger needs a provider other than the one that fired it:

```yaml
triggers:
  - name: discord-fix
    on: discord.mention
    environment: dev
    filters:
      guild: "123456789"
      from_users: ["987654321"]
    agent:
      provider: codex
      mode: full-access
    env:
      GH_TOKEN: ${{ paseo.connections.acme-github.token }}
    prompt: ${{ paseo.event.discord.trigger_message.body }}
```

You must name the connection. An organization can hold several GitHub installations and Hub will not guess between them.

GitHub-triggered executions already receive a scoped `GH_TOKEN` for the triggering repository. You do not need to map one.

## Outputs

```yaml
allow_outputs:
  - type: slack.reply
```

`slack.reply` and `discord.reply` give the agent a `reply` tool for the conversation that triggered it. The reply is plain text, posted in-thread, and can be sent once per execution.

Every execution also gets `finish_execution`, whether or not `allow_outputs` is set.
