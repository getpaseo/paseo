---
title: Hub workflows
description: Build durable Hub workflows with typed inputs, ordered steps, routing, prompt partials, and deadlines.
nav: Workflows
order: 64
category: Hub
---

# Hub workflows

A trigger starts a workflow run. A run evaluates its ordered `steps` one at a time. Each step can choose an environment and agent, render a prompt, send an allowed reply, and finish with an optional structured output.

Use this page for workflow shape and routing. Use [Triggers](/docs/hub/triggers) for provider matching, and the [`hub.yml` reference](/docs/hub/configuration/hub-yml) for the complete field list.

## A complete workflow shape

Execution belongs inside steps. `max_runtime` on the trigger limits the whole run; the same field on a step limits that step.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: route-request
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    inputs:
      repo:
        type: string
        choices: [project, paseo]
      agent:
        type: string
        default: codex
        choices: [codex, claude]
    values:
      selected_repo: ${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}
    steps:
      - id: classify
        if: ${{ paseo.inputs.repo == null }}
        environment: development
        max_runtime: 2m
        idle_timeout: 30s
        agent:
          provider: codex
          model: small-fast-model
          mode: read-only
        prompt:
          - text: |
              Classify this request as project or paseo.
              Request: ${{ paseo.prompt }}
        output:
          schema:
            type: object
            additionalProperties: false
            required: [repo]
            properties:
              repo:
                enum: [project, paseo]

      - id: work
        if: ${{ values.selected_repo == 'project' }}
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        auto_archive: true
        agent:
          provider: ${{ paseo.inputs.agent }}
        prompt:
          - text: |
              Work on the project request.
              Request: ${{ paseo.prompt }}
        allow_outputs:
          - type: slack.reply
            max: 5
```

Steps are ordered. A false `if` marks that step skipped and evaluation continues to the next step. A workflow can finish after a direct-answer step when every later condition is false.

## Inputs and invocation

Declare inputs on the trigger. Callers supply consecutive leading `key=value` tokens, without a `--` delimiter:

```text
@Paseo repo=project agent=claude investigate the failed sync
```

Hub removes the provider mention, consumes the declared input tokens, and passes the rest as the clean prompt:

```json
{
  "inputs": { "repo": "project", "agent": "claude" },
  "prompt": "investigate the failed sync"
}
```

The raw provider message is retained separately as event evidence. Whitespace in the prompt remainder is preserved. The first leading token that is not a declared input stops header parsing; it remains ordinary prompt text, including an undeclared `key=value` token.

Inputs support `string`, `number`, and `boolean` types. `required`, `default`, and finite `choices` are optional fields. Defaults are applied after parsing and are stored with the invocation. A `required` input cannot also have a default.

Values are validated before a run starts. A missing required input, invalid type, invalid choice, duplicate input, or invalid default creates a rejected Activity record and starts no agent. The clean prompt and raw message remain visible on that record.

Use input filters to route deterministically:

```yaml
filters:
  from_users: [U01234567]
  inputs:
    repo: project
```

Two triggers with different `filters.inputs` values form exclusive downstream routes. An invocation that supplies `repo=project` cannot match the `repo=paseo` route. Input filters must name declared inputs and use values allowed by their type and choices.

## Inputs, outputs, and values

These are separate namespaces:

- `${{ paseo.inputs.repo }}` is deterministic caller evidence.
- `${{ steps.classify.outputs.repo }}` is validated evidence returned by an agent.
- `${{ values.selected_repo }}` is a derived binding.
- `${{ paseo.prompt }}` is the clean prompt after the provider mention and consumed input headers.

Values are immutable and lazy. The expression grammar supports path lookup, JSON literals, parentheses, `!`, `==`, `!=`, `&&`, `||`, and `??`. Operators short-circuit. There are no function calls, JavaScript evaluation, arithmetic, property mutation, or implicit string coercion.

The classifier pattern runs only when the caller did not supply a repository:

```yaml
values:
  selected_repo: ${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}

steps:
  - id: classify
    if: ${{ paseo.inputs.repo == null }}
    # ...
  - id: project
    if: ${{ values.selected_repo == 'project' }}
    # ...
  - id: paseo
    if: ${{ values.selected_repo == 'paseo' }}
    # ...
```

The two downstream conditions are exclusive. A failed or timed-out classifier fails the run; it does not silently produce an unclassified route. Referenced step ids and value dependencies are checked when the configuration activates. Cycles and unavailable non-short-circuited outputs fail evaluation.

## Structured step output

Add `output.schema` to a step when later conditions or values need an agent decision. The schema is JSON Schema and is exposed through the step's `finish_execution` capability:

```yaml
output:
  schema:
    type: object
    additionalProperties: false
    required: [kind]
    properties:
      kind:
        enum: [answer, implementation]
```

The agent finishes with:

```text
finish_execution({ output: { kind: "implementation" } })
```

Hub validates the payload at the capability boundary. An invalid payload returns an MCP tool error with validation details, and the step remains live so the agent can retry. A valid payload and the terminal step transition are committed together. A step without `output.schema` keeps the argument-free `finish_execution` contract.

## Direct answer or implementation

Use a classifier output to choose one of two exclusive paths. The answer path has no later step, so it ends without forcing an implementation step.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: support-request
    on: manual.run
    max_runtime: 2h
    filters:
      from_users: [automation]
    inputs:
      kind:
        type: string
        choices: [answer, implementation]
    steps:
      - id: classify
        if: ${{ paseo.inputs.kind == null }}
        environment: development
        max_runtime: 2m
        idle_timeout: 30s
        agent:
          provider: codex
          mode: read-only
        prompt:
          - text: Classify the request as answer or implementation.
          - text: Request: ${{ paseo.prompt }}
        output:
          schema:
            type: object
            additionalProperties: false
            required: [kind]
            properties:
              kind:
                enum: [answer, implementation]

      - id: answer
        if: ${{ paseo.inputs.kind == 'answer' || steps.classify.outputs.kind == 'answer' }}
        environment: development
        max_runtime: 10m
        idle_timeout: 2m
        agent:
          provider: codex
          mode: read-only
        prompt:
          - text: Answer the request. Do not modify the repository.
          - text: ${{ paseo.prompt }}

      - id: implementation
        if: ${{ paseo.inputs.kind == 'implementation' || steps.classify.outputs.kind == 'implementation' }}
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: Implement the request and verify the result.
          - text: ${{ paseo.prompt }}
```

When `kind` is supplied, the classifier is skipped. When it is absent, the classifier must return a valid choice before either branch can run.

## Safety and classification gate

A safety step can return a boolean and a finite route choice. Use the boolean for conditions and keep authority-bearing choices finite.

```yaml
triggers:
  - name: guarded-request
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      from_users: [U01234567]
    steps:
      - id: safety
        environment: development
        max_runtime: 2m
        idle_timeout: 30s
        agent:
          provider: codex
          mode: read-only
        prompt:
          - text: Decide whether this request is safe to run.
          - text: ${{ paseo.prompt }}
        output:
          schema:
            type: object
            additionalProperties: false
            required: [safe]
            properties:
              safe:
                type: boolean

      - id: implementation
        if: ${{ steps.safety.outputs.safe == true }}
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: Implement the approved request.
          - text: ${{ paseo.prompt }}

      - id: rejected
        if: ${{ steps.safety.outputs.safe == false }}
        environment: development
        max_runtime: 5m
        idle_timeout: 1m
        agent:
          provider: codex
          mode: read-only
        prompt:
          - text: Explain briefly why the request cannot be run.
          - text: ${{ paseo.prompt }}
```

## Prompt partials

GitHub-synchronized configurations can load Markdown files from `.paseo/partials/`:

```text
.paseo/
├── hub.yml
└── partials/
    ├── safety.md
    └── developer.md
```

```yaml
prompt:
  - include: safety.md
  - include: developer.md
  - text: |
      Request: ${{ paseo.prompt }}
      Repository route: ${{ values.selected_repo }}
```

Paths are relative to `.paseo/partials/`. Absolute paths, empty segments, `.` and `..`, traversal, symlinks, submodules, and non-file objects are rejected. Includes are not nested: text inside an included file is treated as text.

Hub resolves each include at the exact configuration commit before activation. The path, content, and SHA-256 content hash are stored with that immutable revision. Editing only a partial creates a new revision for later runs. A missing or unsafe partial fails sync and leaves the previous active revision in place. Manual configurations cannot include repository partials.

Inline text and included text use the same interpolation context. Runtime execution does not fetch the repository again.

## Deadlines and restart behavior

Every run has a persisted whole-run deadline and every step has persisted hard and idle deadlines:

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

The run clock includes classification, dispatch delays, every step, and transitions between steps. A step's hard deadline is the earlier of its own limit and the run deadline. Its idle deadline is also capped by both. Meaningful daemon activity refreshes the idle deadline, but never extends either hard deadline.

A step hard or idle timeout fails the run by default. A whole-run timeout stops later steps and interrupts a live agent. Hub persists absolute timestamps before dispatch, so deploying or restarting Hub does not reset a timer. Recovery uses the stored deadlines and Activity shows the resulting failure reason.

## Provider invocation

The input grammar is provider-neutral:

- Slack: mention the bot, then put leading inputs immediately after the mention: `@Paseo repo=project fix the sync`.
- Discord: mention the bot or its managed role, then use the same leading inputs: `@Paseo repo=project fix the sync`.
- GitHub: put the configured marker in the message as required by the trigger filter, then place leading inputs at the start of the text parsed after the marker: `@paseo repo=project fix the sync`.
- Manual: send the same string as the manual run input: `repo=project fix the sync`.

For Slack and Discord, the bot must be genuinely mentioned. For GitHub, `contains` or `pattern` controls where the marker matches. The input tokens belong in the message, not in YAML filter syntax; `filters.inputs` is only for deterministic trigger routing.

See [Slack triggers](/docs/hub/triggers/slack), [Discord triggers](/docs/hub/triggers/discord), [GitHub triggers](/docs/hub/triggers/github), and the [public API](/docs/hub/api) for provider setup and manual dispatch.

## Configuration and Activity evidence

Hub validates the authored document and compiles its references when a revision syncs. Unknown environments, duplicate step ids, invalid durations, unsupported expressions, output-schema errors, unsafe partials, and invalid input filters fail activation with a configuration error. The previous active revision remains active.

After activation, **Project → Activity** shows the provider event, trigger run, raw message, clean prompt, parsed inputs, step statuses, outputs, composed values, deadlines, and failure reason. Rejected input is visible as a rejected run and does not create an agent execution.
