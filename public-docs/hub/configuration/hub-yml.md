---
title: hub.yml reference
description: The authored Hub configuration: environments, triggers, typed inputs, workflow steps, routing, and prompt partials.
nav: hub.yml reference
order: 69
category: Hub
---

# `hub.yml` reference

A configuration has `environments` and `triggers`. It may also include top-level `project` deployment metadata for `paseo hub deploy`. Execution fields belong to each trigger's `steps`.

```yaml
project: my-project

environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: request
    on: manual.run
    max_runtime: 2h
    filters:
      from_users: [automation]
    steps:
      - id: work
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
```

`project` is an optional bare project slug. The deploy CLI uses it to choose the target project when `-p, --project` is absent. The flag takes precedence over this metadata without rewriting the YAML. `project` is not available to triggers, expressions, or agents.

## Environments

| Field      | Required    | Notes                                                                                                     |
| ---------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| `name`     | yes         | Lowercase identifier referenced by a step.                                                                |
| `kind`     | yes         | `daemon`, `fly`, or `docker` in the authored schema; workflow steps must resolve to a daemon environment. |
| `daemon`   | daemon only | Friendly daemon slug, resolved to its immutable ID when the revision activates.                           |
| `cwd`      | daemon only | Absolute path on the daemon.                                                                              |
| `image`    | fly/docker  | Image name.                                                                                               |
| `worktree` | no          | `branch-off`, `checkout-branch`, or `checkout-pr` target.                                                 |

The `worktree` object is part of the environment. Its fields are exact authored names: `newBranch` and optional `base` for `branch-off`, `branch` for `checkout-branch`, and positive integer `prNumber` for `checkout-pr`. Give `base` a remote-tracking ref such as `origin/main`; see [Git worktrees](/docs/worktrees#create-a-worktree-backed-workspace).

## Triggers

| Field         | Required     | Notes                                                                                           |
| ------------- | ------------ | ----------------------------------------------------------------------------------------------- |
| `name`        | yes          | Lowercase identifier, unique in the configuration.                                              |
| `on`          | yes          | `provider.event`, such as `slack.mention` or `manual.run`.                                      |
| `max_runtime` | yes          | Positive duration for the complete trigger run, up to 24h.                                      |
| `filters`     | no in schema | Provider filters; externally sourced triggers still require a non-empty `from_users` allowlist. |
| `inputs`      | no           | Typed leading `key=value` invocation headers.                                                   |
| `values`      | no           | Derived expressions.                                                                            |
| `steps`       | yes          | One or more ordered steps.                                                                      |

### Inputs

Each input has:

```yaml
inputs:
  repo:
    type: string
    required: false
    choices: [project, paseo]
  agent:
    type: string
    default: codex
    choices: [codex, claude]
```

`type` is `string`, `number`, or `boolean`. `required`, `default`, and `choices` are optional. `required` and `default` cannot be combined. Defaults and choices must match the declared type; a default must be one of the choices.

Inputs may be referenced as `${{ paseo.inputs.name }}`. A dynamic authority-bearing field such as a provider, model, mode, or environment requires finite `choices` at activation. A prompt cannot supply authority.

### Values

Values bind expressions under their own namespace:

```yaml
values:
  selected_repo: ${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}
```

The grammar supports paths, JSON literals, parentheses, `!`, `==`, `!=`, `&&`, `||`, and `??`. It does not support function calls, JavaScript, arithmetic, mutation, or implicit string coercion. Referenced steps must exist and value dependencies cannot cycle.

### Steps

| Field           | Required | Notes                                                                                                             |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `id`            | yes      | Lowercase step identifier, unique within the trigger.                                                             |
| `environment`   | yes      | Environment name or a finite input expression resolving to one.                                                   |
| `max_runtime`   | yes      | Positive step hard limit, up to 24h.                                                                              |
| `idle_timeout`  | yes      | Positive idle limit, no longer than the step hard limit.                                                          |
| `agent`         | yes      | `provider`, optional `model`, `mode`, `thinkingOptionId`, and provider-native `options`.                          |
| `prompt`        | yes      | Non-empty list of `text` and GitHub-only `include` blocks.                                                        |
| `if`            | no       | Expression deciding whether this ordered step runs.                                                               |
| `output`        | no       | `{ schema: <JSON Schema> }` for the structured result the agent passes to `hub.finish_execution`.                 |
| `allow_outputs` | no       | Registered output capabilities such as `slack.reply` or `discord.reply`, each with optional `max` and `required`. |
| `auto_archive`  | no       | Archives the step's agent when it ends.                                                                           |

Prompt blocks are objects, not a scalar prompt:

```yaml
prompt:
  - include: developer.md
  - text: |
      <user-prompt>
      ${{ paseo.prompt }}
      </user-prompt>
```

Keep the triggering message in its own final block, wrapped in `<user-prompt>` tags, as [the first workflow](/docs/hub/workflows#your-first-workflow) does.

Use `${{ paseo.prompt }}`, `${{ paseo.inputs.* }}`, `${{ steps.*.outputs.* }}`, and `${{ values.* }}` in prompts, conditions, and agent selection fields. Provider event payloads are not part of this workflow expression namespace; provider adapters put the normalized request into the prompt and preserve the raw event as evidence.

`agent.options` carries JSON-safe options using the selected provider's native names and nesting. Paseo validates them with that provider's strict schema before starting the session. See [Hub security](/docs/hub/security) for the trust boundary and copyable provider examples.

`mode` names a Paseo agent mode ID, which is a separate surface from these options. Some modes keep the provider's interactive approval flow, and that stalls an unattended step, so set the provider's own approval and sandbox settings in `options` instead.

#### Output capabilities

`allow_outputs` separates permission from obligation. `max` limits how many times a capability may be emitted and defaults to `1`. Set `required: true` when the step must emit that capability at least once before it can finish successfully:

```yaml
allow_outputs:
  - type: discord.reply
    max: 1
    required: true
```

Hub counts an actual capability emission; ordinary assistant text does not satisfy a required output. A required declaration must resolve to a registered, available Hub capability for that execution context, or dispatch rejects the step with an actionable configuration error. If delivery fails, the attempt is retryable; if the agent tries to finish first, Hub keeps the execution recoverable and names the concrete output tool before retrying `hub.finish_execution`. A required output must have an effective `max` of at least `1`, or activation rejects the configuration. Omitting `required` preserves optional-output behavior and does not change the agent's permission mode. GitHub-triggered agents reply with their scoped `GH_TOKEN` (for example, through `gh issue comment`) rather than a Hub `github.reply` tool.

A declaration grants the tool. The step's prompt still has to tell the agent to call `hub.reply`, and to call `hub.finish_execution` when it is done. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).

## Prompt partials

`include` paths are relative to `.paseo/partials/`. For GitHub configuration, Hub reads them at the exact configuration commit and stores the resolved content and SHA-256 hash in the immutable revision. For `paseo hub deploy`, the CLI reads the referenced files from the local project root and sends them in the optional `partials` bundle; the bundle path omits the `.paseo/partials/` prefix. Missing files, unsafe paths, symlinks, submodules, directories, duplicate or unexpected bundle entries, and nested includes are rejected. Manual configurations cannot use repository partials.

## Deadlines

The trigger's `max_runtime` is the hard limit for the complete workflow run. Each step also has `max_runtime` and `idle_timeout`:

```yaml
max_runtime: 2h
steps:
  - id: classify
    max_runtime: 2m
    idle_timeout: 30s
  - id: implement
    max_runtime: 90m
    idle_timeout: 10m
```

The effective step hard and idle deadlines are capped by the remaining trigger deadline. Meaningful daemon activity refreshes idle time, but cannot extend a hard deadline. Hub persists absolute deadlines, so a restart or deployment does not reset them. A step timeout fails the run; a trigger timeout stops later steps and interrupts a live agent.

## Provider invocation

The provider removes its mention or marker before Hub parses leading declared input tokens. Slack and Discord place the inputs immediately after the bot mention. GitHub places them after the configured marker. Manual runs send the same string as the API `input`:

```text
@Paseo repo=project investigate the failed sync
```

The first token that is not a declared input begins the prompt. The clean prompt is available as `${{ paseo.prompt }}`. The raw provider message remains separate Activity evidence. See [provider triggers](/docs/hub/triggers) for provider-specific marker and filter behavior.

## Removed fields

Do not put execution fields directly on a trigger. `environment`, `agent`, `prompt`, `timeout`, `idle_timeout`, `auto_archive`, and `allow_outputs` are step fields now. The duration field is `max_runtime`; `timeout` is not an alias.

Next: [Hub workflows](/docs/hub/workflows) for routing patterns and copyable configurations.
