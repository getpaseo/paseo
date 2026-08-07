---
title: Hub examples
description: Copyable Hub workflow configurations for typed routing, classification, direct answers, implementations, and provider replies.
nav: Examples
order: 70
category: Hub
---

# Hub examples

These examples use the durable step syntax. Replace the daemon, paths, provider identifiers, and provider filters with resources in your organization. The shared workflow page explains the contract behind each pattern.

## Model and provider selection

Use finite choices when caller input selects an agent provider or model.

```yaml
environments:
  - name: development
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/project

triggers:
  - name: selectable-agent
    on: manual.run
    max_runtime: 2h
    filters:
      from_users: [automation]
    inputs:
      provider:
        type: string
        default: codex
        choices: [codex, claude]
      model:
        type: string
        default: standard
        choices: [standard, fast]
    steps:
      - id: work
        environment: development
        max_runtime: 90m
        idle_timeout: 10m
        agent:
          provider: ${{ paseo.inputs.provider }}
          model: ${{ paseo.inputs.model }}
          mode: full-access
        prompt:
          - text: ${{ paseo.prompt }}
```

Invoke it with `provider=claude model=fast investigate the sync`. An undeclared leading key stops header parsing and becomes prompt text.

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
          - text: ${{ paseo.prompt }}
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
          - text: ${{ paseo.prompt }}
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
          mode: read-only
        prompt:
          - text: Classify this request as answer or implementation.
          - text: ${{ paseo.prompt }}
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
          - text: Answer the request. Do not change files.
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
          - text: Implement the request, verify it, and report the result.
          - text: ${{ paseo.prompt }}
        allow_outputs:
          - type: github.reply
            max: 5
```

The answer and implementation conditions cannot both be true for one classification. The workflow ends after the answer step because there is no later matching step.

## PR progress and final updates

Keep progress and final updates on the implementation step. The step can use up to five replies while it works, then finish normally.

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
              Request: ${{ paseo.prompt }}
        allow_outputs:
          - type: github.reply
            max: 5
```

For Slack and Discord, use `slack.reply` or `discord.reply` instead. GitHub-triggered agents also receive the scoped GitHub credential for the triggering repository, so the agent can use `gh` for repository updates.

See [Hub workflows](/docs/hub/workflows) for partials, deadlines, structured output retry, and provider invocation details.
