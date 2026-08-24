---
title: GitHub triggers
description: Start Hub workflows from specific GitHub issues, pull requests, comments, and labels.
nav: GitHub
order: 67
category: Hub
---

# GitHub triggers

Use semantic GitHub events to start a workflow from one GitHub action. Add the workflow below to a repository whose `.paseo/hub.yml` defines the `dev` environment and `codex` agent, then activate the bundle.

## Triage new issues

`.paseo/workflows/triage-issue.yml`:

```yaml
name: triage-issue
on: github.issue_created
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
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        issues: write
    prompt:
      - text: |
          Triage the new issue. Add the appropriate labels and leave a short comment
          explaining the result with gh. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`github.issue_created` fires only when someone opens an issue. `from_users` is required and matches the GitHub login that caused the event.

## Review new pull requests

`.paseo/workflows/review-pull-request.yml`:

```yaml
name: review-pull-request
on: github.pull_request_created
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
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        contents: read
        pull_requests: write
    prompt:
      - text: |
          Review the new pull request and submit your findings with gh. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`github.pull_request_created` fires only when someone opens a pull request.

## Respond to new comments

`.paseo/workflows/respond-to-issue-comment.yml`:

```yaml
name: respond-to-issue-comment
on: github.issue_comment_created
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
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        issues: write
    prompt:
      - text: |
          Respond to the new issue comment with gh. Address this request:
          ${{ paseo.prompt }}
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`.paseo/workflows/respond-to-pull-request-comment.yml`:

```yaml
name: respond-to-pull-request-comment
on: github.pull_request_comment_created
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
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        pull_requests: write
    prompt:
      - text: |
          Respond to the new pull-request conversation comment with gh. Address this request:
          ${{ paseo.prompt }}
          Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

Use `github.issue_comment_created` for an issue discussion and `github.pull_request_comment_created` for a pull-request conversation. A comment on a changed line is a diff comment, covered by the legacy `github.pull_request_review_comment` event.

For `github.issue_comment_created`, `github.pull_request_comment_created`, `github.issue_comment`, and `github.pull_request_review_comment`, Hub reacts with 👀 when it accepts the delivery, 🚀 when the agent starts, 👍 on completion, and 👎 on failure.

## Start work when an issue becomes ready

`.paseo/workflows/implement-ready-issue.yml`:

```yaml
name: implement-ready-issue
on: github.issue_label_added
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
    github:
      connection: example-github
      repositories: [example/project]
      permissions:
        contents: write
        issues: write
        pull_requests: write
    prompt:
      - text: |
          Implement the issue that was marked ready for an agent. Create a branch,
          push it, and open a pull request with gh. Use this event context:
          ${{ paseo.context }}
          Call hub.finish_execution when done.
```

`label` matches the label that this event added. The match is case-insensitive, so `ready-for-agent` also matches `Ready-For-Agent`.

## Choose the event

| `on`                                  | Fires when                                           |
| ------------------------------------- | ---------------------------------------------------- |
| `github.issue_created`                | An issue is opened.                                  |
| `github.pull_request_created`         | A pull request is opened.                            |
| `github.issue_comment_created`        | A comment is created on an issue.                    |
| `github.pull_request_comment_created` | A conversation comment is created on a pull request. |
| `github.issue_label_added`            | A label is added to an issue.                        |
| `github.pull_request_label_added`     | A label is added to a pull request.                  |

Choose `github.issue_comment_created` for a comment on an issue and `github.pull_request_comment_created` for a conversation comment on a pull request. GitHub delivers both as issue comments; Hub separates them for you. A comment on a changed line is a diff comment, covered by the legacy `github.pull_request_review_comment` event.

## Filter GitHub events

Every externally sourced workflow needs a non-empty `from_users` allowlist. GitHub filters compose with AND: the repository, connection, sender, content, changed label, and required current labels must all match.

`contains` and `pattern` inspect the title plus body for issue and pull-request events. For comment events, they inspect the comment body. `contains` is a substring match; `pattern` matches the start.

Use `label` with `github.issue_label_added` or `github.pull_request_label_added` when the added label itself matters. Use `labels` when the item must currently have every listed label. Both compare labels case-insensitively. For example, `labels: [bug, backend]` requires both labels; it does not mean either one.

The [configuration reference](/docs/hub/configuration/hub-yml#github-events-and-filters) lists every GitHub event and filter.

## Legacy event compatibility

Existing workflows keep their behavior with `github.issues`, `github.issue_comment`, `github.pull_request_review`, `github.pull_request_review_comment`, and `github.push`. Prefer the semantic events above for new workflows. A semantic workflow and a legacy workflow can both match the same delivery, so they start separate runs.

A GitHub trigger grants no token. Authority is the `github` block on the step that needs it. GitHub has no `hub.reply` capability; the agent acts through `gh` within the declared connection, repositories, and permissions.
