---
title: Forgejo triggers
description: Start Hub workflows from specific Forgejo issues, pull requests, comments, and labels.
nav: Forgejo
order: 67.5
category: Hub
---

# Forgejo triggers

Use semantic Forgejo events to start a workflow from one Forgejo action. Add the workflow below to
a repository whose `.paseo/hub.yml` defines the `dev` environment and `codex` agent, then activate
the bundle.

## Triage new issues

`.paseo/workflows/triage-issue.yml`:

```yaml
name: triage-issue
on: forgejo.issue_created
max_runtime: 2h
filters:
  repo: example/project
  from_users: [maintainer]
steps:
  - id: triage
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    forgejo:
      connection: example-forgejo
      repositories: [example/project]
      issues: write
    prompt:
      - text: |
          Triage the new issue. Add appropriate labels and leave a short comment.
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`forgejo.issue_created` fires only when someone opens an issue. `from_users` is required and
matches the Forgejo login that caused the event.

## Review new pull requests

`.paseo/workflows/review-pull-request.yml`:

```yaml
name: review-pull-request
on: forgejo.pull_request_created
max_runtime: 2h
filters:
  repo: example/project
  from_users: [maintainer]
steps:
  - id: review
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    forgejo:
      connection: example-forgejo
      repositories: [example/project]
      contents: read
      issues: write
    prompt:
      - text: |
          Review the new pull request and submit your findings through Forgejo.
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`forgejo.pull_request_created` fires only when someone opens a pull request.

## Respond to new comments

`.paseo/workflows/respond-to-issue-comment.yml`:

```yaml
name: respond-to-issue-comment
on: forgejo.issue_comment_created
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
steps:
  - id: respond
    environment: dev
    max_runtime: 30m
    idle_timeout: 5m
    agent: codex
    forgejo:
      connection: example-forgejo
      repositories: [example/project]
      issues: write
    prompt:
      - text: |
          Respond to the new issue comment. Address this request:
          ${{ paseo.prompt }}
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

Use `forgejo.issue_comment_created` for an issue discussion and
`forgejo.pull_request_comment_created` for a pull-request conversation. Forgejo delivers both as
issue comments; Hub separates them. A comment on a changed line is covered by the raw
`forgejo.pull_request_review_comment` family.

For `forgejo.issue_comment_created`, `forgejo.pull_request_comment_created`, and
`forgejo.issue_comment`, Hub reacts with `eyes` when it accepts a delivery, `+1` when the agent
completes, and `-1` when the agent fails or is terminated, where the event subject supports
reactions. A submitted review has no reaction target.

## Start work when an issue becomes ready

`.paseo/workflows/implement-ready-issue.yml`:

```yaml
name: implement-ready-issue
on: forgejo.issue_label_added
max_runtime: 2h
filters:
  repo: example/project
  label: ready-for-agent
  from_users: [maintainer]
steps:
  - id: implement
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    forgejo:
      connection: example-forgejo
      repositories: [example/project]
      contents: write
      issues: write
    prompt:
      - text: |
          Implement the issue that was marked ready for an agent. Create a branch,
          push it, and open a pull request. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`label` matches the label this event added. The match is case-insensitive, so `ready-for-agent`
also matches `Ready-For-Agent`.

## Choose the event

| `on`                                   | Fires when                                           |
| -------------------------------------- | ---------------------------------------------------- |
| `forgejo.issue_created`                | An issue is opened.                                  |
| `forgejo.pull_request_created`         | A pull request is opened.                            |
| `forgejo.issue_comment_created`        | A comment is created on an issue.                    |
| `forgejo.pull_request_comment_created` | A conversation comment is created on a pull request. |
| `forgejo.issue_label_added`            | A label is added to an issue.                        |
| `forgejo.pull_request_label_added`     | A label is added to a pull request.                  |

Choose `forgejo.issue_comment_created` for a comment on an issue and
`forgejo.pull_request_comment_created` for a conversation comment on a pull request. A semantic
workflow and a raw-family workflow can both match the same delivery, so they start separate runs.

## Filter Forgejo events

Every externally sourced workflow needs a non-empty `from_users` allowlist. Forgejo filters
compose with AND: the repository, connection, sender, content, changed label, and required current
labels must all match.

`contains` and `pattern` inspect the title plus body for issue and pull-request events. For comment
events, they inspect the comment body. `contains` is a substring match; `pattern` matches the
start.

Use `label` with `forgejo.issue_label_added` or `forgejo.pull_request_label_added` when the added
label itself matters. Use `labels` when the item must currently have every listed label. Both
compare labels case-insensitively. The [configuration reference](/docs/hub/configuration/hub-yml#forgejo-events-and-filters)
lists the field contract.

## Native raw families

Existing workflows can continue to use `forgejo.issues`, `forgejo.issue_comment`,
`forgejo.pull_request`, `forgejo.pull_request_review`,
`forgejo.pull_request_review_comment`, and `forgejo.push`. Prefer the semantic events above for
new workflows. Forgejo's event headers, payloads, and supported reaction targets stay native to
Forgejo; this is a capability match, not a GitHub protocol emulation.

A Forgejo trigger grants no token. Authority is the `forgejo` block on the step that needs it. See
[Forgejo access](/docs/hub/forgejo) for the repository and capability boundary.
