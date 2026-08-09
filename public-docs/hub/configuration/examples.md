---
title: Hub examples
description: Copyable Hub workflow configurations for typed routing, classification, direct answers, implementations, and provider replies.
nav: Examples
order: 70
category: Hub
---

# Hub examples

These examples use the durable step syntax. Replace the daemon, paths, provider identifiers, and provider filters with resources in your organization. The shared workflow page explains the contract behind each pattern.

Each prompt names the Hub tool its step should call and keeps the triggering message in its own `<user-prompt>` block. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).

## Let the classifier pick the repository and the model

One read-only classifier reads the request and decides two things: which repository the work belongs to, and how big a model it needs. A caller who already knows either answer can supply it and skip the guess.

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
  - name: request
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
      model:
        type: string
        choices: [gpt-5.5, gpt-5.4-mini]
    values:
      selected_repo: ${{ paseo.inputs.repo ?? steps.classify.outputs.repo }}
      selected_model: ${{ paseo.inputs.model ?? steps.classify.outputs.model }}
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
          - text: Decide which repository this request belongs to, and pick gpt-5.4-mini for a small question or gpt-5.5 for real work.
          - text: Call hub.finish_execution with the classification as the structured result.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
        output:
          schema:
            type: object
            additionalProperties: false
            required: [repo, model]
            properties:
              repo:
                enum: [project, paseo]
              model:
                enum: [gpt-5.5, gpt-5.4-mini]

      - id: project-work
        if: ${{ values.selected_repo == 'project' }}
        environment: project
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          model: ${{ values.selected_model }}
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
        if: ${{ values.selected_repo == 'paseo' }}
        environment: paseo
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          model: ${{ values.selected_model }}
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

The classifier runs, then exactly one worker does. The conditions are exclusive, so the YAML lists a step per repository while a run only ever executes one of them.

The two axes reach their step differently. A model is a value, so `${{ values.selected_model }}` goes straight into `agent.model`. A repository is a configured environment with its own `cwd` and worktree, so it cannot come from an expression: each repository gets its own predeclared environment and its own conditional step. Both routes stay finite, which is what lets an agent-produced value choose them at all — `choices` on the inputs, `enum` in the output schema.

Invoke it with `repo=paseo investigate the failed sync` to pin the repository and let the classifier still choose the model. An undeclared leading key stops header parsing and becomes prompt text.

## Repository routing

Use a declared input plus `filters.inputs` when separate triggers should own separate repositories or projects.

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

The same event can match multiple triggers, so the input filters make these routes exclusive.

## Safety gate and direct answer

For a request that may either be answered or implemented, let a read-only classifier choose a finite branch. Supplying `kind=answer` or `kind=implementation` skips classification.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: request
    on: github.issue_comment
    max_runtime: 2h
    filters:
      repo: example/project
      contains: "@paseo"
      from_users: [maintainer]
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
          options:
            approval_policy: never
            sandbox_mode: read-only
            web_search: disabled
        prompt:
          - text: Classify this request as answer or implementation.
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
        if: ${{ paseo.inputs.kind == 'answer' || steps.classify.outputs.kind == 'answer' }}
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
          - text: Answer the request. Do not change files.
          - text: Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>

      - id: implementation
        if: ${{ paseo.inputs.kind == 'implementation' || steps.classify.outputs.kind == 'implementation' }}
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: Implement the request, verify it, and report the result.
          - text: Post the result as an issue comment with `gh`.
          - text: Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
```

The answer and implementation conditions cannot both be true for one classification. The workflow ends after the answer step because there is no later matching step.

The classifier passes its result under `output`, and Hub validates it against the step's schema. [Structured outputs](/docs/hub/workflows#structured-outputs) shows the exact call and what an invalid one does.

The implementation branch comments through the scoped GitHub credential the trigger provides; the read-only answer branch has no write or network authority to do that. On Slack and Discord, grant `slack.reply` or `discord.reply` on the branch that answers and tell the agent to call `hub.reply`.

## PR progress and final updates

Keep progress and final updates on the implementation step. The step comments while it works, then finishes.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: pr-work
    on: github.pull_request_review_comment
    max_runtime: 2h
    filters:
      repo: example/project
      contains: "@paseo"
      from_users: [maintainer]
    steps:
      - id: implement-review
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        auto_archive: true
        agent:
          provider: codex
          mode: full-access
        prompt:
          - text: |
              Address the review request.

              Post progress and the final result as pull request comments with `gh`.
              Call hub.finish_execution when the step is complete.
          - text: |
              <user-prompt>
              ${{ paseo.prompt }}
              </user-prompt>
```

GitHub-triggered agents receive the scoped GitHub credential for the triggering repository, so they comment, push, and open pull requests with `gh`. For Slack and Discord, grant `slack.reply` or `discord.reply` on the step with the `max` it needs, and tell the agent to call `hub.reply` for each update.

See [Hub workflows](/docs/hub/workflows) for partials, deadlines, structured output retry, and provider invocation details.
