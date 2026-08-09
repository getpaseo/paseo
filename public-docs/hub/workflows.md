---
title: Hub workflows
description: Learn how Hub turns a provider event into one or more ordered agent steps, from a single reply to classifier-driven routing.
nav: Workflows
order: 64
category: Hub
---

# Hub workflows

A workflow is the work Hub performs after a trigger matches an event. You describe it in `.paseo/hub.yml`, next to the environments where your agents run.

```text
Slack mention → Hub trigger → workflow step → Paseo daemon → agent
```

## Your first workflow

One Slack trigger and one agent that answers in the thread:

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

Mention the bot in the configured channel:

```text
@Paseo how do I run the project locally?
```

Hub removes the mention and gives the agent `how do I run the project locally?` as `${{ paseo.prompt }}`. The agent answers through `hub.reply`, which posts in the thread, and Project → Activity records the event, the step, the outcome, and the reply.

`agent.options` passes Codex's own settings through unchanged: no approval prompts, a read-only sandbox, no web search. Nobody is watching an unattended step, so one that stops to ask an approval question goes nowhere. [Provider-native controls](/docs/hub/security#provider-native-controls) has the equivalent block for each provider.

The last prompt block wraps the triggering message in `<user-prompt>` tags and keeps it as its own prompt item, so the agent can tell the request apart from your instructions. Tags are a formatting convention; [Hub security](/docs/hub/security) covers the allowlists, provider policy, and output authority that decide what an agent may do with the request.

For GitHub, Discord, and manual runs, only the trigger and invocation change. The steps work the same way. See [Triggers](/docs/hub/triggers) for provider matching.

## Tell the agent which tool to call

Hub attaches its own tools to every step, and the prompt has to name the one you want. An agent that is not told can end its turn with the answer only in its own transcript: nothing delivered, no output recorded, and the step left to its `idle_timeout`.

- `hub.reply` sends a user-facing response to the conversation that triggered the workflow. It exists only when the step's `allow_outputs` grants a matching capability.
- `hub.finish_execution` marks the step complete and records the structured result when the step declares an `output` schema.

A step that answers a person names both, as the first workflow does:

```text
Call hub.reply to send your response to the originating conversation.
Call hub.finish_execution when the step is complete.
```

A step that only feeds a later step names `hub.finish_execution` alone. Most classifiers never reply.

## Share prompt text between steps

Put shared instructions in `.paseo/partials/base.md`:

```markdown
Follow the repository's conventions.
Keep the work focused on the request.
```

Include the file in each step that needs it:

```yaml
steps:
  - id: review
    prompt:
      - include: base.md
      - text: Review the request and call hub.finish_execution when complete.

  - id: implement
    prompt:
      - include: base.md
      - text: Implement the request and call hub.finish_execution when complete.
```

See [prompt partials](/docs/hub/configuration/hub-yml#prompt-partials) for path resolution, deployment, and validation.

## Scenarios

:::example[Make a change instead of answering]
`mode: full-access` lets the agent edit files and run commands. The environment gets a worktree, so the work happens on its own branch instead of your checkout.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

triggers:
  - name: slack-work
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: work
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Make the change, verify it, and report what you did.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
```

Base the worktree on `origin/main` rather than `main`. [Git worktrees](/docs/worktrees#create-a-worktree-backed-workspace) explains why, along with setup hooks and scripts.
:::

:::example[Report progress while working]
`max` is how many times a step may use a capability, and it defaults to `1`. Raise it and tell the agent to send updates as it goes.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

triggers:
  - name: slack-work
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: work
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Make the change, verify it, and report what you did.

              Call hub.reply when you start, when something surprising happens,
              and when you finish.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
            max: 5
```

Set `required: true` when a step must send at least one reply before it can finish successfully. See [output capabilities](/docs/hub/configuration/hub-yml#output-capabilities).
:::

:::example[Turn an issue into a pull request]
A `github` block on the step grants the authority: a token scoped to the listed repositories and permissions, plus a git setup that commits and pushes with it. See [GitHub access](/docs/hub/github).

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

triggers:
  - name: issue-to-pr
    on: github.issues
    max_runtime: 2h
    filters:
      repo: example/project
      from_users: [maintainer]
    steps:
      - id: implement
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        auto_archive: true
        github:
          connection: example-github
          repositories:
            - example/project
          permissions:
            contents: write
            pull_requests: write
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Implement what the issue asks for, verify it, commit, push the
              branch, and open a pull request with `gh pr create`.

              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
```

GitHub sends an `issues` event for every issue action, so opening, editing, or closing an issue as a listed user each starts a run. `${{ paseo.prompt }}` carries the issue title and body.

The trigger and the block are independent. The trigger only starts the run; without the block the agent has no token, GitHub-triggered or not. `hub.reply` covers Slack and Discord, so here the deliverable is the pull request and `hub.finish_execution` completes the step. `auto_archive` archives the agent when the step ends.
:::

:::example[Plan first, then implement]
Steps run in order, and each one gets its own agent, limits, and authority. Here a read-only step posts a plan and a full-access step carries it out.

```yaml
environments:
  - name: triage
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

triggers:
  - name: slack-work
    on: slack.mention
    max_runtime: 3h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: plan
        environment: triage
        max_runtime: 10m
        idle_timeout: 2m
        agent:
          provider: codex
          options:
            approval_policy: never
            sandbox_mode: read-only
            web_search: disabled
        prompt:
          - text: |
              Read the code and write the approach you would take. Change nothing.

              Call hub.finish_execution with the approach as the structured result.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        output:
          schema:
            type: object
            additionalProperties: false
            required: [plan]
            properties:
              plan:
                type: string

      - id: implement
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Carry out this approach, verify it, and report the result.

              ${{ steps.plan.outputs.plan }}

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
```

Each step is a separate agent execution with its own prompt, and nothing carries over on its own. The second agent never sees the first agent's transcript. The only thing that crosses is what the first step declared under `output` and the second step interpolated, which is why the plan is a schema field here rather than a sentence in a reply.

Environments do not carry over either. A worktree environment creates a worktree for each execution that uses it, so two steps sharing one worktree environment get two branches rather than one shared working directory. The planning step runs in `triage`, which has no worktree, because it only reads.

An output that a prompt interpolates does not need finite choices. That requirement applies to `agent.provider`, `agent.model`, `agent.mode`, and `environment`, which is covered further down.
:::

:::example[Let the caller choose]
A declared input is a typed value the caller supplies as a leading `key=value` token. Hub validates it before any agent starts.

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
    inputs:
      model:
        type: string
        default: gpt-5.5
        choices: [gpt-5.5, gpt-5.4-mini]
    steps:
      - id: answer
        environment: development
        max_runtime: 30m
        idle_timeout: 5m
        agent:
          provider: codex
          model: ${{ paseo.inputs.model }}
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

```text
@Paseo model=gpt-5.4-mini how do I run the project locally?
```

Hub reads leading `key=value` tokens that match declared inputs. `gpt-5.4-mini` becomes `${{ paseo.inputs.model }}`, and the rest is the prompt. The first token that is not a declared input starts the prompt, so ordinary text is never consumed.

An input that selects a provider, model, or mode needs `choices`. A prompt cannot supply authority. Types, defaults, and rejected values are in the [`hub.yml` reference](/docs/hub/configuration/hub-yml#inputs).
:::

:::example[Send two repositories to two triggers]
When two routes should stay separate, give each its own trigger and match on the supplied input with `filters.inputs`.

```yaml
environments:
  - name: project
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

  - name: paseo
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/paseo

triggers:
  - name: project-request
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      from_users: [U01234567]
      inputs: { repo: project }
    inputs:
      repo:
        type: string
        choices: [project, paseo]
    steps:
      - id: project-work
        environment: project
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Do the work in this repository.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
            max: 5

  - name: paseo-request
    on: slack.mention
    max_runtime: 2h
    filters:
      workspace: T01234567
      from_users: [U01234567]
      inputs: { repo: paseo }
    inputs:
      repo:
        type: string
        choices: [project, paseo]
    steps:
      - id: paseo-work
        environment: paseo
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Do the work in this repository.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
            max: 5
```

One event can match several triggers and all of them run; the input filters are what keep these two routes exclusive.

```text
@Paseo repo=paseo investigate the failed sync
```

:::

:::example[Let the agent choose the model]
A structured output is a JSON value an agent returns when it finishes. Declare its schema with an `enum`, and a later step can read the decision.

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
          - text: |
              Pick gpt-5.4-mini for a small question and gpt-5.5 for real work.

              Call hub.finish_execution with the choice as the structured result.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        output:
          schema:
            type: object
            additionalProperties: false
            required: [model]
            properties:
              model:
                enum: [gpt-5.5, gpt-5.4-mini]

      - id: answer
        environment: development
        max_runtime: 30m
        idle_timeout: 5m
        agent:
          provider: codex
          model: ${{ steps.classify.outputs.model }}
          mode: full-access
        prompt:
          - text: |
              Handle this request.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
```

The classifier calls the tool with its result under `output`:

```text
hub.finish_execution({ output: { model: "gpt-5.4-mini" } })
```

Hub validates that object against the schema. An invalid one returns an MCP error and the same agent can correct it and call again. A valid one completes the step and makes the value available as `${{ steps.classify.outputs.model }}`.

The `enum` is what allows an agent-produced value to select a model at all. An output that selects a provider, model, or mode has to prove its choices are finite, through an `enum` or a `const`.
:::

:::example[Let the agent choose the repository]
A model is a value, so it goes straight into `agent.model`. A repository is a configured environment with its own `cwd`, and `environment` takes a literal name or `${{ paseo.inputs.<name> }}` and nothing else. Give each repository its own environment and its own conditional step.

```yaml
environments:
  - name: triage
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

  - name: project
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

  - name: paseo
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/paseo
    worktree:
      mode: branch-off
      newBranch: hub/work
      base: origin/main

triggers:
  - name: slack-work
    on: slack.mention
    max_runtime: 3h
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    steps:
      - id: classify
        environment: triage
        max_runtime: 2m
        idle_timeout: 30s
        agent:
          provider: codex
          options:
            approval_policy: never
            sandbox_mode: read-only
            web_search: disabled
        prompt:
          - text: |
              Decide which repository this request belongs to.

              Call hub.finish_execution with the choice as the structured result.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        output:
          schema:
            type: object
            additionalProperties: false
            required: [repo]
            properties:
              repo:
                enum: [project, paseo]

      - id: project-work
        if: ${{ steps.classify.outputs.repo == 'project' }}
        environment: project
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Do the work in this repository.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
            max: 5

      - id: paseo-work
        if: ${{ steps.classify.outputs.repo == 'paseo' }}
        environment: paseo
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Do the work in this repository.

              Call hub.reply to send your response to the originating conversation.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        allow_outputs:
          - type: slack.reply
            max: 5
```

Steps run in order, and Hub skips a step whose `if` is false. The two conditions here cannot both be true, so the configuration lists a step per repository while a run only ever executes one of them.

The classifier runs in `triage`, which has no worktree, because a read-only classification does not need a branch. The same shape scopes credentials: a `github` block on each worker grants authority for its own repository, and the classifier holds none. See [GitHub access](/docs/hub/github#only-the-step-that-needs-it).
:::

:::example[Accept a caller override with a classifier fallback]
`values` binds an expression under its own name, and `??` takes the first side that is present. A caller who already knows the answer supplies it, and the classifier covers everyone else.

```yaml
values:
  selected_repo: ${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}
```

Declare `repo` as an input with `choices`, keep the classifier's `enum` output, and give the classifier a condition so it only runs when it is needed:

```yaml
inputs:
  repo:
    type: string
    choices: [project, paseo]

steps:
  - id: classify
    if: ${{ paseo.inputs.repo == null }}
    # unchanged from the scenario above

  - id: project-work
    if: ${{ values.selected_repo == 'project' }}
    # unchanged from the scenario above

  - id: paseo-work
    if: ${{ values.selected_repo == 'paseo' }}
    # unchanged from the scenario above
```

Both sides of a `??` used for authority have to be finite on their own: `choices` on the input, an `enum` in the output schema. A composed value can select a provider, model, or mode. It cannot select an environment, which is why the branches above still test `values.selected_repo` rather than feeding it to `environment`.

The namespaces stay separate:

- `${{ paseo.inputs.repo }}` — deterministic caller evidence.
- `${{ steps.classify.outputs.repo }}` — structured agent evidence.
- `${{ values.selected_repo }}` — a composed value.
  :::

## Choosing between a caller input and a classifier

| Use                 | When                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| Deterministic input | The caller knows the answer and should control the route.                             |
| Classifier output   | The route depends on the request and the caller should not have to label it.          |
| Both                | Give experienced callers an explicit override and use classification as the fallback. |

A read-only classifier is also a way to keep authority away from the step that reads untrusted text. It reduces exposure without being a boundary. [Hub security](/docs/hub/security) covers the trust boundary, provider-native controls, and what to check before pointing a workflow at a public repository.

## Next

The [`hub.yml` reference](/docs/hub/configuration/hub-yml) covers every field, expression, and limit, including [prompt partials](/docs/hub/configuration/hub-yml#prompt-partials) for text shared between steps, [deadlines](/docs/hub/configuration/hub-yml#deadlines), and [provider invocation](/docs/hub/configuration/hub-yml#provider-invocation).

Then return to [Configuration](/docs/hub/configuration) to connect the file to a project, or [Activity](/docs/hub/activity) to inspect a run.
