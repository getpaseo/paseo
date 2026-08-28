---
title: Hub configuration reference
description: Canonical Hub resource, workflow, agent, expression, and prompt fields.
nav: Configuration reference
order: 71
category: Hub
---

# Hub configuration reference

Hub accepts YAML in this layout:

```text
.paseo/
├── hub.yml
└── workflows/
    ├── <workflow>.yml
    └── partials/
        └── <partial>.md
```

Only direct `.yml` children of `.paseo/workflows/` are workflows. Each file contains one trigger and its ordered steps. There is no manifest, `includes`, `uses`, reusable step, workflow call, or inheritance.

## `hub.yml`

`.paseo/hub.yml` contains named project resources. Names are map keys and are not repeated inside each object.

```yaml
environments:
  paseo:
    kind: daemon
    daemon: laptop
    cwd: /Users/you/code/paseo
  hub:
    kind: daemon
    daemon: devbox
    cwd: /workspace/hub

agents:
  codex-safe:
    provider: codex
    model: gpt-5.5
    thinkingOptionId: xhigh
    options:
      sandbox_workspace_write:
        writable_roots: [/var/cache/npm]
        network_access: false
  claude:
    provider: claude
    mode: bypassPermissions
```

The only top-level keys are `environments` and `agents`. A `triggers` key is rejected with a migration error.

### Environments

| Field      | Required    | Notes                                                                          |
| ---------- | ----------- | ------------------------------------------------------------------------------ |
| `kind`     | yes         | `daemon`, `fly`, or `docker`; workflow steps must select a daemon environment. |
| `daemon`   | daemon only | Registered daemon slug, resolved when the revision activates.                  |
| `cwd`      | daemon only | Absolute working directory on the daemon.                                      |
| `image`    | fly/docker  | Image name.                                                                    |
| `worktree` | no          | `branch-off`, `checkout-branch`, or `checkout-pr` target.                      |

For `worktree`, use `newBranch` and optional `base` with `branch-off`, `branch` with `checkout-branch`, or positive `prNumber` with `checkout-pr`.

```yaml
environments:
  review:
    kind: daemon
    daemon: build-server
    cwd: /workspace/project
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
```

`newBranch` is a branch-name string. Embed `${{ paseo.execution.id }}`, which renders the execution's UUID, so every execution branches off `base` on its own branch and keeps it when Hub retries or recovers that execution.

One execution is one step run, so two steps selecting the same environment get separate branches.

`${{ paseo.execution.id }}` is the only expression `newBranch` accepts. `paseo.prompt`, `paseo.context`, `paseo.inputs.*`, `values.*`, `steps.<id>.outputs.*`, and provider event fields are unavailable here, and each one fails bundle activation at the authored field, such as `.paseo/hub.yml.environments.review.worktree.newBranch`.

`${{ paseo.execution.id }}` fails activation the same way anywhere else in a bundle. `branch` and `prNumber` take literal values.

An environment is a complete named object. A step selects its name; objects are not inherited, merged, or partially overridden.

### Named agents

Each agent is one complete provider configuration:

| Field              | Required | Notes                                                            |
| ------------------ | -------- | ---------------------------------------------------------------- |
| `provider`         | yes      | Provider ID.                                                     |
| `model`            | no       | Provider model ID.                                               |
| `mode`             | no       | Paseo mode ID.                                                   |
| `thinkingOptionId` | no       | Provider thinking option.                                        |
| `options`          | no       | JSON-safe provider-native options, preserving names and nesting. |

A named selection preserves the complete object, including structured options. Named agents have no parent, patch, or per-step override.

Hub passes `model`, `mode`, `thinkingOptionId`, and `options` to the Paseo daemon without renaming or flattening provider fields. The selected daemon validates them against its current provider schema; Hub does not translate provider-native options.

## Workflow files

`.paseo/workflows/review.yml`:

```yaml
name: review
on: manual.run
max_runtime: 2h
filters:
  from_users: [automation]
inputs:
  repo:
    type: string
    required: true
    choices: [paseo, hub]
steps:
  - id: inspect
    environment: ${{ paseo.inputs.repo }}
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex-safe
    prompt:
      - text: ${{ paseo.prompt }}
```

| Field         | Required | Notes                                                     |
| ------------- | -------- | --------------------------------------------------------- |
| `name`        | yes      | Workflow name, unique across the bundle.                  |
| `on`          | yes      | Provider event such as `manual.run` or `discord.mention`. |
| `max_runtime` | yes      | Hard limit for the complete run, up to 24h.               |
| `filters`     | yes      | Provider resource filters and the sender allowlist.       |
| `inputs`      | no       | Typed invocation headers.                                 |
| `values`      | no       | Named expressions.                                        |
| `steps`       | yes      | One or more ordered inline steps.                         |

### GitHub events and filters

Use one of these semantic event names for new GitHub workflows:

| `on`                                  | Matches                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `github.issue_created`                | An `issues` delivery whose action is `opened`.                            |
| `github.pull_request_created`         | A `pull_request` delivery whose action is `opened`.                       |
| `github.issue_comment_created`        | An `issue_comment` delivery whose action is `created`, on an issue.       |
| `github.pull_request_comment_created` | An `issue_comment` delivery whose action is `created`, on a pull request. |
| `github.issue_label_added`            | An `issues` delivery whose action is `labeled`.                           |
| `github.pull_request_label_added`     | A `pull_request` delivery whose action is `labeled`.                      |

Existing configurations may continue to use `github.issues`, `github.issue_comment`, `github.pull_request_review`, `github.pull_request_review_comment`, and `github.push`. These legacy events retain their existing behavior.

`filters` supports these GitHub fields. `from_users` must be non-empty for every externally sourced workflow. All supplied filters compose with AND.

| Field        | Type                                | Applies to                                                    | Meaning                                                                         |
| ------------ | ----------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `from_users` | non-empty list of strings           | all GitHub events                                             | GitHub logins allowed to start the workflow.                                    |
| `repo`       | non-empty string                    | all GitHub events                                             | Repository in `owner/name` form.                                                |
| `connection` | string                              | all GitHub events                                             | GitHub connection slug.                                                         |
| `contains`   | string                              | issue, pull-request, and comment events                       | Substring in the issue or pull-request title plus body, or in the comment body. |
| `pattern`    | string                              | issue, pull-request, and comment events                       | Start of that same text.                                                        |
| `label`      | non-empty string                    | `github.issue_label_added`, `github.pull_request_label_added` | The label added by the delivery.                                                |
| `labels`     | non-empty list of non-empty strings | issue, pull-request, and comment events                       | Every listed label must be currently present on the issue or pull request.      |

`label` and `labels` match GitHub labels case-insensitively. `label` checks the one changed label; `labels` checks the full current label set and requires every entry. For example, `labels: [bug, backend]` requires both `bug` and `backend`.

Use `label` only with a label-added event. It has no match on other events. Use `labels` to require the item state, including when a comment starts the workflow.

See [GitHub triggers](/docs/hub/triggers/github) for complete triage, pull-request review, and ready-for-agent workflows.

### Inputs and values

Inputs have `type: string | number | boolean`, plus optional `required`, `default`, and `choices`. `required` and `default` cannot be combined. Finite `choices` are required when an input can choose authority such as an environment or named agent.

Values bind expressions:

```yaml
values:
  selected_environment: ${{ steps.classify.outputs.environment }}
  selected_agent: ${{ steps.classify.outputs.agent }}
```

Expressions may read declared `paseo.inputs`, earlier `steps.<id>.outputs`, and `values`. The grammar supports paths, JSON literals, parentheses, `!`, `==`, `!=`, `&&`, `||`, and `??`.

An environment or dynamic named-agent expression must have a finite set of possible string results at activation. Every result must name a configured resource. Runtime selection never falls back to another environment or agent.

### Steps

| Field                | Required | Notes                                                                                    |
| -------------------- | -------- | ---------------------------------------------------------------------------------------- |
| `id`                 | yes      | Unique within the workflow.                                                              |
| `environment`        | yes      | Literal environment name or finite expression resolving to one.                          |
| `max_runtime`        | yes      | Step hard limit.                                                                         |
| `idle_timeout`       | yes      | Idle limit no longer than `max_runtime`.                                                 |
| `agent`              | yes      | Named agent, finite expression selecting a named agent, or complete static inline agent. |
| `prompt`             | yes      | Ordered `text` and `include` blocks.                                                     |
| `if`                 | no       | Expression deciding whether the step runs.                                               |
| `env`                | no       | Environment variables from connection values.                                            |
| `output.schema`      | no       | JSON Schema for structured step output.                                                  |
| `allow_outputs`      | no       | Provider output capabilities with optional `max` and `required`.                         |
| `auto_archive`       | no       | Archive the agent after the step ends.                                                   |
| `workspace_affinity` | no       | Opt into a durable daemon-owned workspace key for related trigger arrivals.              |
| `github`             | no       | Explicit GitHub authority for this step.                                                 |

An inline agent is static and complete:

```yaml
agent:
  provider: codex
  model: gpt-5.5
  options:
    approval_policy: never
    sandbox_mode: read-only
```

An expression-valued `agent` selects a named agent. Dynamic provider fields inside an inline object are rejected.

### Workspace affinity

`workspace_affinity` is an explicit step-level lease for a daemon workspace. It is useful when
multiple events from one Slack thread, Discord thread, GitHub issue, or pull request should use the
same workspace:

```yaml
steps:
  - id: reply
    environment: paseo
    max_runtime: 30m
    idle_timeout: 5m
    auto_archive: true
    workspace_affinity:
      key: "review:${{ paseo.trigger.conversation_key }}"
    agent: codex-safe
    prompt:
      - text: Reply to the current conversation.
```

`paseo.trigger.conversation_key` is available only in `workspace_affinity.key`. It is generated
from provider-authenticated event identifiers: Slack uses its connection, workspace, channel, and
root thread; Discord uses its connection, guild, channel, and thread or starter message; GitHub
uses its connection, repository, issue or pull-request type, and number. A literal key is also
valid when intentionally sharing a workspace, and finite declared inputs, values, and step outputs
may be composed into a key. Prompt text, ambient context, execution IDs, and unbounded values are
rejected so an event cannot steer itself into a pre-existing workspace.

Hub passes the opaque key and the workflow's `max_runtime` deadline to the daemon. The daemon hashes
and persists the mapping, reuses an active workspace, and restores an archived workspace when a
matching event arrives. Each matching event extends retention through its own workflow deadline.
With `auto_archive: true`, the daemon archives the workspace at that retained deadline; it does not
use `idle_timeout`, which remains a liveness deadline for the current execution. With
`auto_archive: false`, the daemon does not perform affinity-driven workspace archiving.
Disconnecting or revoking the Hub relationship does not cancel a deadline the daemon already
acknowledged; persisted affinity cleanup resumes after daemon restart.

Workspace affinity is a progressive daemon capability. Older daemons ignore the optional lease and
continue using their existing fresh-workspace behavior; Hub still runs the workflow and does not
require an immediate daemon upgrade. Exact reuse, retention, and archived-workspace restoration take
effect after the daemon is updated to a version that acknowledges workspace affinity.

Affinity shares a workspace, not an agent or a queue: matching executions may run concurrently.
Every use of the same key must use the same daemon environment target, cwd, worktree target, and
auto-archive policy. A target mismatch is rejected. In particular, a worktree branch containing
`${{ paseo.execution.id }}` is unique per execution, so Hub rejects that combination during
configuration validation.

### Prompt semantics

```yaml
prompt:
  - include: partials/review.md
  - text: |
      <user-prompt>
      ${{ paseo.prompt }}
      </user-prompt>
```

`${{ paseo.prompt }}` is the normalized request after the provider marker and declared leading `key=value` inputs are removed. It is not rewritten or augmented with event context.

`${{ paseo.context }}` opts that step into provider context materialization and renders the result as JSON in the prompt. It is available only in prompt text. Hub does not inject it unless the workflow authors that expression.

Includes resolve relative to `.paseo/workflows/`, so shared partials use `partials/<name>.md`. Missing files, absolute or traversing paths, symlinks, content mismatches, and files outside the partial tree are rejected.

### Output capabilities

Authority stays on the step that uses it:

```yaml
allow_outputs:
  - type: discord.reply
    max: 1
    required: true
```

Slack workflows use `slack.reply`; Discord workflows use `discord.reply`. The declaration grants `hub.reply`, and the prompt must tell the agent to call it. GitHub has no reply output; use an explicit [`github` block](/docs/hub/github).

Every step receives `hub.finish_execution`. The prompt must tell the agent when to call it; Hub does not append completion or reply instructions. If `output.schema` is present, `hub.finish_execution` requires an `output` value that matches the schema. If an `allow_outputs` entry is `required: true`, the agent must emit that output before finishing. `max` defaults to `1`.

## Migrating a monolithic file

Keep `environments` in `hub.yml`, convert the environment list to a named map, and move each former trigger into its own `.paseo/workflows/<name>.yml` file. Move shared prompt files to `.paseo/workflows/partials/`. Define complete named agent configurations under `agents` and replace dynamic provider fields with finite named-agent selection.

Hub does not read TOML or a monolithic `triggers` section, and the CLI does not rewrite either format.

See [Workflows](/docs/hub/workflows) for complete routing examples.
