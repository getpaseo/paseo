---
title: GitHub triggers
description: Configure GitHub events with explicit step-scoped GitHub authority.
nav: GitHub
order: 67
category: Hub
---

# GitHub triggers

| `on`                                 | Event                                |
| ------------------------------------ | ------------------------------------ |
| `github.issue_comment`               | Comment on an issue or pull request. |
| `github.issues`                      | Issue event.                         |
| `github.pull_request_review`         | Pull request review.                 |
| `github.pull_request_review_comment` | Diff comment.                        |

GitHub sends every subscribed action. Each delivery that passes the filters starts a run.

`.paseo/workflows/github-change.yml`:

```yaml
name: github-change
on: github.issue_comment
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
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
        pull_requests: write
    prompt:
      - text: |
          Implement the request and open a pull request with gh.
          Call hub.finish_execution when done.
          ${{ paseo.prompt }}
```

`from_users` matches the GitHub login. `contains` checks event text and `pattern` checks its start. Comment events use the comment body; issue events use title plus body.

A GitHub trigger grants no token. Authority is the `github` block on the step that needs it. GitHub has no `hub.reply` capability; the agent acts through `gh` within the declared connection, repositories, and permissions.

On comment events, Hub reacts with 👀 when accepted, 🚀 when the agent starts, 👍 on completion, and 👎 on failure. `${{ paseo.prompt }}` contains normalized request text, not event identifiers. Use `${{ paseo.context }}` in prompt text when the step explicitly needs provider context.
