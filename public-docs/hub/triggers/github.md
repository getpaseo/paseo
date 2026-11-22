---
title: GitHub triggers
description: Start Hub agents from GitHub issues, pull requests, comments, pushes, and labels.
nav: GitHub
order: 65
category: Hub
---

# GitHub triggers

Use semantic GitHub events to start an agent from one GitHub action. First connect a GitHub account under **Integrations** (or configure a [GitHub App](/docs/hub/self-hosting/github-app) on a self-hosted Hub).

## Triage new issues

`.paseo/triggers/triage-issue.yml`:

```yaml
name: triage-issue
on:
  github.issue_created:
    connection: acme-github
    filters:
      repo: acme/project
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  max_runtime: 30m
  idle_timeout: 5m
  github:
    connection: acme-github
    repositories: [acme/project]
    permissions:
      issues: write
  prompt: |
    Triage the new issue, apply appropriate labels with gh, and post a short summary using reply.
    Event context:
    ${{ paseo.context }}
    Call finish_execution when done.
```

`github.issue_created` fires only when an issue is opened. `from_users` is required and matches the GitHub login that caused the event.

## Review pull requests

`.paseo/triggers/review-pr.yml`:

```yaml
name: review-pr
on:
  github.pull_request_ready_for_review:
    connection: acme-github
    filters:
      repo: acme/project
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: acme-github
    repositories: [acme/project]
    permissions:
      contents: read
      pull_requests: write
  prompt: |
    Review the pull request and submit your findings with gh.
    Fetch live PR state with gh pr view before reviewing and before posting.
    Skip posting if the PR is draft or its head SHA changed.
    Event context:
    ${{ paseo.context }}
    Call finish_execution when done.
```

Use `github.pull_request_created` to run when a pull request opens, `github.pull_request_ready_for_review` to wait until a draft is marked ready, or `github.pull_request_synchronized` to run when new commits are pushed to an open pull request.

Pull request context includes `github.pull_request.draft` and `github.pull_request.head_sha`. Converting a pull request back to draft does not cancel a run already in progress, so check live state with `gh pr view` before posting.

## Respond to comments

`.paseo/triggers/respond-issue-comment.yml`:

```yaml
name: respond-issue-comment
on:
  github.issue_comment_created:
    connection: acme-github
    filters:
      repo: acme/project
      contains: "@paseo"
      exclude_contains: "@paseo-deploy"
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  max_runtime: 30m
  idle_timeout: 5m
  prompt: |
    Answer the issue comment using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
    Event context:
    ${{ paseo.context }}
  outputs:
    github.reply:
      max: 1
      required: true
```

Use `github.issue_comment_created` for comments on issues and `github.pull_request_comment_created` for conversation comments on pull requests. GitHub sends both as issue comments, and Hub separates them for you.

`exclude_contains` skips comments that contain text claimed by another trigger, such as a separate command prefix.

On `github.issue_comment_created`, `github.pull_request_comment_created`, `github.issue_comment`, and `github.pull_request_review_comment`, Hub adds reactions as the run progresses: 👀 when accepted, 🚀 when started, 👍 on completion, and 👎 on failure.

## Start work on a label

`.paseo/triggers/implement-ready-issue.yml`:

```yaml
name: implement-ready-issue
on:
  github.issue_label_added:
    connection: acme-github
    filters:
      repo: acme/project
      label: ready-for-agent
      from_users: [maintainer]
run:
  target:
    daemon: devbox
    cwd: /workspace/project
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
  agent:
    provider: codex
    mode: full-access
  max_runtime: 90m
  idle_timeout: 10m
  github:
    connection: acme-github
    repositories: [acme/project]
    permissions:
      contents: write
      issues: write
      pull_requests: write
  prompt: |
    Implement the labeled issue on this worktree branch, push it, and open a pull request with gh.
    Post the PR link to the issue using reply, then call finish_execution.
    Event context:
    ${{ paseo.context }}
```

`label` matches the exact label added by this event, case-insensitively. Use `github.pull_request_label_added` for labels added to pull requests.

## Supported events

| `on`                                   | Fires when                                          |
| -------------------------------------- | --------------------------------------------------- |
| `github.issue_created`                 | An issue is opened.                                 |
| `github.pull_request_created`          | A pull request is opened.                           |
| `github.pull_request_ready_for_review` | A draft pull request is marked ready for review.    |
| `github.pull_request_synchronized`     | New commits are pushed to an open pull request.     |
| `github.issue_comment_created`         | A comment is posted on an issue.                    |
| `github.pull_request_comment_created`  | A conversation comment is posted on a pull request. |
| `github.issue_label_added`             | A label is added to an issue.                       |
| `github.pull_request_label_added`      | A label is added to a pull request.                 |

Hub also accepts raw webhook event names (`github.issues`, `github.issue_comment`, `github.pull_request`, `github.pull_request_review`, `github.pull_request_review_comment`, `github.push`) when you need diff review comments or push events. Prefer semantic events for new triggers.

## Filters

Every GitHub trigger requires a non-empty `from_users` allowlist. All supplied filters compose with AND.

Use `from_users: ["*"]` to accept pushes from any sender. Hub does not extract the sender login from push events, so a list of named logins never matches.

| Filter             | Applies to                                                    | Meaning                                                                    |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `from_users`       | All GitHub events                                             | GitHub logins allowed to trigger the run.                                  |
| `repo`             | All GitHub events                                             | Repository in `owner/name` form.                                           |
| `contains`         | Issue, pull-request, and comment events                       | Substring in the issue or PR title plus body, or in the comment body.      |
| `exclude_contains` | Issue, pull-request, and comment events                       | Substring that prevents the event from matching.                           |
| `pattern`          | Issue, pull-request, and comment events                       | Prefix at the start of that same text.                                     |
| `label`            | `github.issue_label_added`, `github.pull_request_label_added` | Required. The label added by this delivery, case-insensitively.            |
| `labels`           | Issue, pull-request, and comment events                       | Every listed label must be present on the issue or PR, case-insensitively. |

## Replies and GitHub tokens

GitHub triggers on an issue or pull request automatically grant the `reply` tool (`github.reply`), which posts a comment on that issue or pull request and appends an **Open in Paseo** link when Hub runs over HTTPS. Add `run.outputs.github.reply` when you want to cap `max` replies or set `required: true`.

A GitHub trigger grants no `GH_TOKEN` by default. Add a [`run.github` block](/docs/hub/github) when the agent needs `git` or `gh` access to push branches, open pull requests, or edit labels.
