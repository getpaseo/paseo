---
title: Hub workflows
description: Learn how Hub turns a provider event into one or more ordered agent steps.
nav: Workflows
order: 64
category: Hub
---

# Hub workflows

A workflow is the work Hub performs after a trigger matches an event. You describe it in `.paseo/hub.yml`, next to the environments where your agents run.

The basic shape is small:

```text
Slack mention → Hub trigger → workflow step → Paseo daemon → agent
```

You can stop there with one step. Add deterministic inputs when the person invoking the workflow should choose a route. Add structured outputs when an agent should make a decision for a later step.

## Your first workflow

Start with one Slack trigger and one agent step:

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: slack-help
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: answer
        environment: development
        max_runtime: 30m
        idle_timeout: 5m
        agent:
          provider: codex
          options:
            approval_policy: never
            sandbox_mode: read-only
            web_search: disabled
        prompt:
          - text: |
              Help with this request.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
```

`agent.options` passes Codex's own settings through unchanged: no approval prompts, a read-only sandbox, no web search. Nobody is watching an unattended step, so one that stops to ask an approval question goes nowhere. [Provider-native controls](/docs/hub/security#provider-native-controls) has the equivalent block for each provider.

Mention the bot in the configured channel:

```text
@Paseo how do I run the project locally?
```

Hub removes the mention and gives the agent `how do I run the project locally?` as `${{ paseo.prompt }}`. The prompt tells it to call `hub.reply`, which posts in the thread through the step's `slack.reply` capability.

The last block wraps the triggering message in `<user-prompt>` tags and keeps it as its own prompt item, so the agent can tell the request apart from your instructions. Tags are a formatting convention; [Hub security](/docs/hub/security) covers the allowlists, provider policy, and output authority that decide what an agent may do with the request.

What happens next:

- Slack delivers the mention to Hub.
- Hub checks the trigger event and filters, including the user allowlist.
- Hub creates a workflow run and starts the `answer` step on the matching daemon.
- The agent works with the prompt, replies, and finishes through Hub.
- Project → Activity records the event, step, outcome, and any reply.

For GitHub, Discord, and manual runs, only the trigger and invocation change. The workflow steps work the same way. See [Triggers](/docs/hub/triggers) for provider matching.

## Tell the agent which tool to call

Hub attaches its own tools to every step, and the prompt has to name the one you want. An agent that is not told can end its turn with the answer only in its own transcript: nothing delivered, no output recorded, and the step left to its `idle_timeout`.

- `hub.reply` sends a user-facing response to the conversation that triggered the workflow. It exists only when the step's `allow_outputs` grants a matching capability.
- `hub.finish_execution` marks the step complete and records the structured result when the step declares an `output` schema.

A step that answers a person names both, as the first workflow does:

```text
Call hub.reply to send your response to the originating conversation.
Call hub.finish_execution when the step is complete.
```

A step that only feeds a later step names `hub.finish_execution` alone; most classifiers never reply. [Structured outputs](#structured-outputs) has that version.

## Deterministic inputs

A deterministic input is a typed value supplied by the person or system that invokes the workflow. Hub validates it before starting an agent. Use one when the caller should make an explicit choice, such as selecting a repository or agent.

Declare the input on the trigger:

```yaml
inputs:
  repo:
    type: string
    choices: [project, paseo]
  agent:
    type: string
    default: codex
    choices: [codex, claude]
```

The caller puts declared inputs at the start of the message:

```text
@Paseo repo=project agent=claude investigate the failed sync
```

Hub stores these values under `paseo.inputs` and passes the remaining text as the prompt:

```text
paseo.inputs.repo  = "project"
paseo.inputs.agent = "claude"
paseo.prompt       = "investigate the failed sync"
```

Inputs can be `string`, `number`, or `boolean`. Add `required`, `default`, or `choices` when needed. A value that does not match its type or choices, a missing required value, or a duplicate input creates a rejected Activity record and starts no agent.

The first word that is not a declared input starts the prompt. This lets ordinary text remain ordinary text:

```text
@Paseo repo=project status=blocked explain the failure
```

If `status` is not declared, the prompt is `status=blocked explain the failure`. It is not treated as workflow input.

### Deterministic routing

Use `filters.inputs` when different triggers should own different choices:

```yaml
filters:
  from_users: [U01234567]
  inputs:
    repo: project
```

Create a second trigger with `repo: paseo` and the same input declaration. The two routes are exclusive for a supplied `repo` value. See [Repository routing](/docs/hub/configuration/examples#repository-routing) for a complete configuration.

## Structured outputs

A structured output is a JSON value an agent returns when it finishes a step. Declare its JSON Schema when a later step needs to use the decision.

This example asks one agent whether the request needs an answer or implementation, then runs only the matching step:

```yaml
steps:
  - id: classify
    environment: development
    max_runtime: 2m
    idle_timeout: 30s
    agent:
      provider: codex
      options:
        approval_policy: never
        sandbox_mode: read-only
        web_search: disabled
    prompt:
      - text: Classify the request as answer or implementation.
      - text: Call hub.finish_execution with the classification as the structured result.
      - text: |
          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
    output:
      schema:
        type: object
        additionalProperties: false
        required: [kind]
        properties:
          kind:
            enum: [answer, implementation]

  - id: answer
    if: ${{ steps.classify.outputs.kind == 'answer' }}
    environment: development
    max_runtime: 10m
    idle_timeout: 2m
    agent:
      provider: codex
      options:
        approval_policy: never
        sandbox_mode: read-only
        web_search: disabled
    prompt:
      - text: Answer the request without changing files.
      - text: Call hub.finish_execution when the step is complete.
      - text: |
          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>

  - id: implementation
    if: ${{ steps.classify.outputs.kind == 'implementation' }}
    environment: development
    max_runtime: 90m
    idle_timeout: 10m
    agent:
      provider: codex
      mode: full-access
    prompt:
      - text: Implement the request and verify the result.
      - text: Call hub.finish_execution when the step is complete.
      - text: |
          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
```

The classifier calls `hub.finish_execution` with:

```text
hub.finish_execution({ output: { kind: "implementation" } })
```

Hub validates that object against the schema. If it is invalid, the tool returns an MCP error and the same agent can correct and call it again. A valid output completes the step and makes it available as `${{ steps.classify.outputs.kind }}` to later steps.

Use classification as defense in depth, then give reply or implementation authority only to the downstream step that needs it. [Hub security](/docs/hub/security) covers the trust boundary and provider-native controls.

Steps run in order. When a step's `if` condition is false, Hub skips it and evaluates the next step. In this example, only one downstream condition can be true. If the answer step runs, the workflow ends without starting the implementation step.

## Deterministic input or classifier?

Choose based on where the decision comes from:

| Use                 | When                                                                                  | Example                                                                     |
| ------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Deterministic input | The caller knows the answer and should control the route.                             | `repo=project` selects the project environment.                             |
| Classifier output   | The route depends on the request and the caller should not have to label it.          | A read-only agent decides whether a request is an answer or implementation. |
| Both                | Give experienced callers an explicit override and use classification as the fallback. | Supplied `repo` skips classification; absent `repo` runs it.                |

An agent-produced value cannot grant arbitrary authority. If an output selects a provider, model, mode, or environment, the configuration must prove the possible choices are finite.

The namespaces stay separate:

- `${{ paseo.inputs.repo }}` — deterministic caller evidence.
- `${{ steps.classify.outputs.repo }}` — structured agent evidence.
- `${{ values.selected_repo }}` — a composed value.

Compose an override and fallback with `??`:

```yaml
values:
  selected_repo: ${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}

steps:
  - id: classify
    if: ${{ paseo.inputs.repo == null }}
    # ...
```

When `repo` is supplied, the classifier is skipped and its output is not read. When it is absent, classification must succeed before a downstream route can run.

## Common patterns

Once the basic workflow makes sense, use these complete examples:

- [Model and provider selection](/docs/hub/configuration/examples#model-and-provider-selection)
- [Repository and project routing](/docs/hub/configuration/examples#repository-routing)
- [Safety gate and direct answer](/docs/hub/configuration/examples#safety-gate-and-direct-answer)
- [PR progress and final updates](/docs/hub/configuration/examples#pr-progress-and-final-updates)
- [Prompt partials](/docs/hub/configuration/hub-yml#prompt-partials)
- [Deadlines](/docs/hub/configuration/hub-yml#deadlines)
- [Provider invocation](/docs/hub/configuration/hub-yml#provider-invocation)

## Next

The [`hub.yml` reference](/docs/hub/configuration/hub-yml) covers every field, expression, prompt partial, reply capability, and deadline. It also documents activation errors and the exact limits for each field.

Then return to [Configuration](/docs/hub/configuration) to connect the file to a project, or [Activity](/docs/hub/activity) to inspect a run.
