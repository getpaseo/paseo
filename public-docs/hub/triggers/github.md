---
title: GitHub triggers
description: Configure GitHub events as Hub triggers and route them into durable workflows.
nav: GitHub
order: 67
category: Hub
---

# GitHub triggers

## Events

| `on`                                 | Event                                  |
| ------------------------------------ | -------------------------------------- |
| `github.issue_comment`               | A comment on an issue or pull request. |
| `github.issues`                      | An issue.                              |
| `github.pull_request_review`         | A pull request review.                 |
| `github.pull_request_review_comment` | A comment on a diff.                   |

Hub does not filter by webhook action. GitHub delivers a subscribed event for every action — created, edited, closed, deleted — and each delivery that passes the trigger's filters starts a run.

Which repositories produce events is set on the GitHub App installation. `filters.repo` narrows a trigger to one `owner/name` repository.

## Filters

```yaml
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
```

`from_users` matches the sender's GitHub login. `contains` checks the event text; `pattern` checks its start. The text is the comment body for comments and reviews, and the issue title plus body for issues. All filters must pass.

## Invocation

Put the configured marker in the message, then put leading inputs in the text parsed after that marker:

```text
@paseo repo=project agent=claude investigate the failed sync
```

Hub consumes only declared consecutive headers and passes `investigate the failed sync` as `${{ paseo.prompt }}`. See [Hub workflows](/docs/hub/workflows) for input types, defaults, choices, and rejected Activity records.

## Credentials and replies

A GitHub trigger grants nothing by itself. A step that should comment, push, or open a pull request declares a [`github` block](/docs/hub/github); without one the agent has no token and no git configuration.

The event's identifiers are not part of the prompt. `${{ paseo.prompt }}` carries the comment body for comment events and the title plus body for issues, so give the agent work it can complete from that text alone — opening a pull request, for example — rather than replying to a thread it has no way to locate.

On comment events, Hub reacts on the triggering comment: 👀 when it accepts the event, 🚀 when the agent starts, 👍 when the step completes, and 👎 when it fails. Plain issue events get no reaction; watch those runs in Project → Activity.

`hub.reply` covers Slack and Discord, not GitHub. See [Tell the agent which tool to call](/docs/hub/workflows#tell-the-agent-which-tool-to-call).
