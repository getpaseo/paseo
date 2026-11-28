---
title: Trigger YAML reference
description: Complete field reference for Hub self-contained trigger documents in .paseo/triggers/*.yml.
nav: Trigger YAML reference
order: 74
category: Hub
---

# Trigger YAML reference

Each `.paseo/triggers/<name>.yml` file defines one self-contained Hub trigger. The Hub dashboard YAML view and `POST /api/v1/triggers/install` accept the same format.

## Top-level fields

| Field         | Required | Default           | Notes                                                                                             |
| ------------- | -------- | ----------------- | ------------------------------------------------------------------------------------------------- |
| `name`        | yes      | none              | Unique trigger identifier (`^[a-z][a-z0-9_-]*$`). Redeploying updates by `name`.                  |
| `enabled`     | no       | `true`            | Disabled triggers keep their configuration and stop accepting new runs.                           |
| `on`          | yes      | none              | Non-empty map of event names to event definitions (`connection`, `filters`, `recurrence`).        |
| `inputs`      | no       | none              | Typed invocation headers (`type: string \| number \| boolean`, `required`, `default`, `choices`). |
| `max_runtime` | no       | `run.max_runtime` | Hard limit for the whole trigger run, up to `24h`.                                                |
| `run`         | yes      | none              | Target daemon, agent configuration, continuation, prompt, limits, tools, and outputs.             |

## Event definitions (`on`)

Each key under `on` is an event name:

- Provider events (`github.*`, `linear.*`, `slack.mention`, `discord.mention`) accept optional `connection` (integration slug) and `filters`. See [Triggers](/docs/hub/triggers#events) for the full event and filter tables.
- `schedule.tick` requires `recurrence` (`start`, `rule`, `timezone`) and rejects `connection` and `filters`. See [Scheduled triggers](/docs/hub/triggers/schedules).
- `webhook.received` accepts an empty object `{}` and rejects `connection` and `filters`. See [Inbound webhooks](/docs/hub/triggers/webhooks).
- `manual.run` accepts `{}` or `filters.from_users` for API dispatch. See [Hub public API](/docs/hub/api#manual-run-dispatch).

One trigger document can list more than one event under `on`. The dashboard visual form edits single-event triggers, and multi-event triggers stay editable in YAML view.

## Target and worktree

`run.target` selects the daemon and directory where the agent executes:

| Field      | Required | Notes                                                                          |
| ---------- | -------- | ------------------------------------------------------------------------------ |
| `daemon`   | yes      | Connected daemon slug with `hub.execute` permission.                           |
| `cwd`      | yes      | Existing directory on that daemon, with an absolute path that starts with `/`. |
| `worktree` | no       | Optional git worktree mode: `branch-off`, `checkout-branch`, or `checkout-pr`. |

For example, `/home/me/project` uses the required path format. Hub rejects Windows drive paths such as `C:\work\project`.

Worktree modes:

- `branch-off`: requires `newBranch` and optional `base`. Embed `${{ paseo.execution.id }}` in `newBranch` (for example `trigger-${{ paseo.execution.id }}`) so each execution gets a unique branch that survives retries. `${{ paseo.execution.id }}` is the only expression accepted in `newBranch`.
- `checkout-branch`: requires literal `branch`.
- `checkout-pr`: requires positive integer `prNumber`.

## Agent selection

`run.agent` defines either one static agent configuration or a finite choice selected from an input:

| Field              | Required | Notes                                                                                                                        |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `provider`         | yes      | Any provider configured on the target daemon (for example `codex`, `claude`, `opencode`, `pi`, or a custom/plugin provider). |
| `model`            | no       | Provider model ID.                                                                                                           |
| `mode`             | no       | Provider execution mode ID. Required in the dashboard form when the provider offers modes.                                   |
| `thinkingOptionId` | no       | Provider thinking option ID.                                                                                                 |
| `options`          | no       | JSON-safe provider-native options object, passed through without renaming.                                                   |

Hub asks the connected daemon to validate `provider`, `model`, `mode`, `thinkingOptionId`, and `options` whenever you save or deploy.

To let an invocation input choose between complete predefined agent configurations, use `select` and `choices`:

```yaml
name: choose-agent
on:
  manual.run: {}
inputs:
  agent:
    type: string
    required: true
    choices: [codex-read, claude-work]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    select: ${{ paseo.inputs.agent }}
    choices:
      codex-read:
        provider: codex
        mode: read-only
      claude-work:
        provider: claude
        mode: bypassPermissions
  prompt: Handle this request and call finish_execution.
```

Dynamic fields inside an inline agent object are rejected. Every possible `select` result must match a key in `choices`.

## Agent continuation

`run.continuation` controls whether new arrivals reuse an existing agent or start a new one:

| Value                                                     | Behavior                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{ mode: conversation }`                                  | Default. Reuses the agent for the same Slack or Discord thread, GitHub issue or PR, or Linear issue. Starts a new agent when no conversation exists. |
| `{ mode: key, key: "ticket-${{ paseo.inputs.ticket }}" }` | Reuses the agent for the evaluated key (non-empty string up to 512 characters).                                                                      |
| `{ mode: new }`                                           | Starts a new agent for every arrival.                                                                                                                |

A continuing agent keeps its original daemon, working directory, worktree branch, agent configuration, `background` flag, and tool grants. Changing any of those settings for the same continuation key fails until you switch to `{ mode: new }` or pick a new key.

When a follow-up arrives while the agent is busy, Hub steers the running agent without extending its original runtime deadline. Pass the prompt's `executionId` to `reply` and `finish_execution` so outputs bind to the right arrival.

## Prompt, context, and title

| Field             | Required | Default | Notes                                                                                              |
| ----------------- | -------- | ------- | -------------------------------------------------------------------------------------------------- |
| `prompt`          | yes      | none    | Instruction text sent to the agent.                                                                |
| `title`           | no       | none    | Optional Paseo workspace title template (literal text plus `${{ paseo.execution.id }}`).           |
| `max_runtime`     | no       | `2h`    | Hard runtime limit, up to `24h`.                                                                   |
| `idle_timeout`    | no       | `10m`   | Idle timeout, no longer than `max_runtime`.                                                        |
| `startup_timeout` | no       | `2m`    | Waiting budget for worktree creation and provider startup, up to `24h`.                            |
| `auto_archive`    | no       | `true`  | Archives the workspace after execution finishes.                                                   |
| `background`      | no       | `false` | Creates a background Paseo workspace hidden from default workspace lists. Older daemons ignore it. |

Prompt expressions:

- `${{ paseo.prompt }}` inserts the complete received message text for provider events, or the framed webhook body for `webhook.received`. For `webhook.received`, omitting `${{ paseo.prompt }}` appends the framed body automatically.
- `${{ paseo.context }}` opts the run into provider context materialization (thread history, issue metadata, schedule metadata, or attachment descriptors) rendered as JSON. Hub does not inject ambient context unless you author `${{ paseo.context }}`.
- `${{ paseo.inputs.<name> }}` inserts a declared input value.

Wrap untrusted external text in a clear delimiter such as `<user-prompt>...</user-prompt>`.

## Output capabilities

Hub attaches its execution MCP server to every run and always exposes `finish_execution`.

Hub grants the `reply` tool when the event has an issue, pull request, or thread to reply to. Replies are optional and unlimited by default.

A `github.push` event has no reply destination. If you set `run.outputs.github.reply.required: true` for a push, Hub fails the run before it starts the agent.

Set `run.outputs` to cap replies with `max` or require a reply before `finish_execution`.

```yaml
run:
  outputs:
    slack.reply:
      max: 1
      required: true
```

Supported reply capability keys are `github.reply`, `linear.reply`, `slack.reply`, and `discord.reply`. Hub does not rewrite your prompt, so tell the agent when to call `reply` and `finish_execution`.

To require structured JSON output on `finish_execution`, set `run.output.schema` to a JSON Schema object.

## Tools, GitHub, and environment

- `run.tools` grants scoped Slack and Discord MCP tools (`read` and `post` on explicit channel IDs). See [Integration tools](/docs/hub/tools).
- `run.github` mints a scoped `GH_TOKEN` and isolated git configuration. See [GitHub access](/docs/hub/github).
- `run.env` injects environment variables, including `${{ paseo.connections.<slug>.token }}`.
