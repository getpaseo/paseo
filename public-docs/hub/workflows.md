---
title: Hub workflows
description: Build ordered Hub workflows with prompts, routing, outputs, and provider authority.
nav: Workflows
order: 65
category: Hub
---

# Hub workflows

A workflow file contains one trigger and the ordered steps it starts. Files are discovered from `.paseo/workflows/*.yml`.

## Your first workflow

Assume `.paseo/hub.yml` defines an environment named `dev` and an agent named `codex`. Add `.paseo/workflows/slack-help.yml`:

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
          Answer the request. Call hub.reply once, then call hub.finish_execution.

          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
    allow_outputs:
      - { type: slack.reply, max: 1, required: true }
```

Hub removes the mention and declared input headers before exposing the remaining text as `${{ paseo.prompt }}`. The reply capability is explicit beside the Slack trigger. Discord uses `discord.reply`; GitHub uses a step-scoped [`github` block](/docs/hub/github), not `hub.reply`.

## Choose where a step runs

A literal selects one named environment:

```yaml
environment: dev
```

A finite input can select among complete named environments:

```yaml
name: route-repository
on: manual.run
max_runtime: 1h
inputs:
  repo:
    type: string
    required: true
    choices: [paseo, hub]
steps:
  - id: work
    environment: ${{ paseo.inputs.repo }}
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    prompt:
      - text: ${{ paseo.prompt }}
```

Activation checks every `choices` result. Environment objects are never merged or overridden by a workflow.

## Choose an agent

A step may select a named agent:

```yaml
agent: codex-safe
```

Or provide one complete static inline configuration:

```yaml
agent:
  provider: claude
  mode: full-access
```

For dynamic routing, select complete named agents from a finite expression:

```yaml
name: route-agent
on: manual.run
max_runtime: 1h
inputs:
  agent:
    type: string
    required: true
    choices: [codex-safe, claude]
steps:
  - id: work
    environment: paseo
    max_runtime: 30m
    idle_timeout: 5m
    agent: ${{ paseo.inputs.agent }}
    prompt:
      - text: ${{ paseo.prompt }}
```

If `codex-safe` contains structured sandbox options in `hub.yml`, selecting it carries those options unchanged. A dynamic inline object such as `provider: ${{ paseo.inputs.agent }}` is rejected.

## Route from a classifier

An earlier step can return finite structured output. Later authority must be bounded by `enum` or `const` in that output schema.

```yaml
name: classify-request
on: discord.mention
max_runtime: 2h
filters:
  guild: "123456789012345678"
  from_users: ["345678901234567890"]
values:
  selected_environment: ${{ steps.classify.outputs.environment }}
  selected_agent: ${{ steps.classify.outputs.agent }}
steps:
  - id: classify
    environment: hub
    max_runtime: 5m
    idle_timeout: 1m
    agent: claude
    prompt:
      - include: partials/classify.md
      - text: ${{ paseo.prompt }}
    output:
      schema:
        type: object
        required: [environment, agent]
        properties:
          environment: { enum: [paseo, hub] }
          agent: { enum: [codex-safe, claude] }
        additionalProperties: false
  - id: work
    environment: ${{ values.selected_environment }}
    max_runtime: 1h
    idle_timeout: 10m
    agent: ${{ values.selected_agent }}
    prompt:
      - text: |
          Complete the request. Call hub.reply once, then call hub.finish_execution.
      - text: ${{ paseo.prompt }}
    allow_outputs:
      - { type: discord.reply, max: 1, required: true }
```

`.paseo/workflows/partials/classify.md`:

```text
Choose one configured repository environment and one complete named agent configuration.
```

The workflow keeps one classifier branch and one worker branch. It does not duplicate a worker step for every environment/provider pair.

## Prompt and context

Prompt blocks remain ordered. Includes are literal file contents; Hub does not recursively scan partial text.

```yaml
prompt:
  - include: partials/instructions.md
  - text: |
      Provider evidence:
      ${{ paseo.context }}

      <user-prompt>
      ${{ paseo.prompt }}
      </user-prompt>
```

- `${{ paseo.prompt }}` is normalized request text. It is always explicit in the authored prompt.
- `${{ paseo.context }}` opts this step into provider context materialization and inserts JSON. Without that expression, Hub does not fetch or inject ambient context.

Keep untrusted request text in a clearly delimited block. A partial is instruction text, not hidden authority.

## Conditions and ordered output

Steps run in file order. `if` may read inputs, values, and prior step output:

```yaml
name: conditional-review
on: manual.run
max_runtime: 1h
steps:
  - id: inspect
    environment: paseo
    max_runtime: 10m
    idle_timeout: 2m
    agent: codex-safe
    prompt:
      - text: ${{ paseo.prompt }}
    output:
      schema:
        type: object
        required: [needs_review]
        properties:
          needs_review: { type: boolean }
        additionalProperties: false
  - id: review
    if: ${{ steps.inspect.outputs.needs_review == true }}
    environment: paseo
    max_runtime: 30m
    idle_timeout: 5m
    agent: claude
    prompt:
      - text: Review the prior result and call hub.finish_execution.
```

A step cannot read a later step. Step IDs are unique within the workflow.

## Tell the agent which tool to call

`allow_outputs` grants a capability; it does not rewrite the prompt. Name the required action:

```yaml
prompt:
  - text: |
      Send the final answer with hub.reply.
      Then call hub.finish_execution.
allow_outputs:
  - type: slack.reply
    max: 1
    required: true
```

`max` defaults to `1`. `required: true` prevents successful completion until the capability has been emitted. Keep Slack and Discord reply types in their own provider workflow files.

## Deadlines

The workflow `max_runtime` limits the complete run. Every step has its own `max_runtime` and `idle_timeout`; remaining workflow time caps both. A timeout fails the run and stops later steps.

The [configuration reference](/docs/hub/configuration/hub-yml) lists every field. Provider filters and invocation text are in [Triggers](/docs/hub/triggers).
