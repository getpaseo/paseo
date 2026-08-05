---
title: GitHub triggers
description: GitHub events Hub can trigger on, how filters match them, and the full paseo.event.github data reference.
nav: GitHub
order: 65
category: Hub
---

# GitHub triggers

## Events

| `on`                                 | Fires when                            |
| ------------------------------------ | ------------------------------------- |
| `github.issue_comment`               | A comment on an issue or pull request |
| `github.issues`                      | An issue is opened or edited          |
| `github.pull_request_review`         | A review is submitted                 |
| `github.pull_request_review_comment` | A comment on a diff                   |

Which repositories produce events is set on the GitHub connection's installation, not in Paseo.

## Filters

```yaml
filters:
  repo: acme/api
  contains: "@paseo"
  from_users: [alice, bob]
```

- `from_users` matches the GitHub **login** of the event's sender.
- `repo` is `owner/name`, resolved to the repository's immutable id on activation.
- `contains` is a substring test; `pattern` must match at the start.

The text those two search depends on the event:

| Event                                | Text searched        |
| ------------------------------------ | -------------------- |
| `github.issue_comment`               | The comment body     |
| `github.issues`                      | Issue title and body |
| `github.pull_request_review`         | The review body      |
| `github.pull_request_review_comment` | The comment body     |

## Tokens

A GitHub-triggered execution automatically receives a `GH_TOKEN` scoped to the triggering repository, with `contents`, `issues`, and `pull_requests` write access. It is minted per execution and revoked when the execution ends. You do not map it in `env`.

For a token from a _different_ connection, or from a non-GitHub trigger, name it explicitly:

```yaml
env:
  GH_TOKEN: ${{ paseo.connections.acme-github.token }}
```

## Data reference

GitHub's webhook payload is available directly under `paseo.event.github`, unflattened. Anything GitHub sends, you can read:

```yaml
prompt: |
  ${{ paseo.event.github.issue.title }}
  by ${{ paseo.event.github.sender.login }}
  on ${{ paseo.event.github.repository.full_name }}
```

Common paths by event:

| Event                                | Useful paths                                                                    |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| `github.issue_comment`               | `comment.body`, `comment.html_url`, `issue.number`, `issue.title`, `issue.body` |
| `github.issues`                      | `issue.number`, `issue.title`, `issue.body`, `action`                           |
| `github.pull_request_review`         | `review.body`, `review.state`, `pull_request.number`                            |
| `github.pull_request_review_comment` | `comment.body`, `comment.path`, `comment.diff_hunk`, `pull_request.number`      |

All events also carry `sender.login`, `repository.full_name`, and `repository.default_branch`.

Hub adds an envelope alongside GitHub's fields:

| Path                   | Value                                          |
| ---------------------- | ---------------------------------------------- |
| `delivery_id`          | GitHub's webhook delivery id                   |
| `event_name`           | `issue_comment`, `issues`, …                   |
| `repository_full_name` | `owner/name`                                   |
| `installation_id`      | The installation that delivered the event      |
| `received_at`          | When Hub accepted it                           |
| `trigger_url`          | Canonical URL of the comment, issue, or review |

`trigger_url` is only present when the event has one. It is the field you usually want in a prompt.

## Example

```yaml
triggers:
  - name: review-fix
    on: github.pull_request_review_comment
    environment: dev
    filters:
      repo: acme/api
      contains: "@paseo"
      from_users: [alice]
    agent:
      provider: codex
      mode: full-access
    prompt: |
      ${{ paseo.event.github.sender.login }} left this on PR
      #${{ paseo.event.github.pull_request.number }},
      in ${{ paseo.event.github.comment.path }}:

      ${{ paseo.event.github.comment.body }}

      Fix it and push. Reply on the thread with gh when you're done.
      ${{ paseo.event.github.trigger_url }}
```
