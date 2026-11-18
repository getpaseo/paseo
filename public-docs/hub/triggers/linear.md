---
title: Linear triggers
description: Run Hub workflows from Linear issue activity and post replies to the issue.
nav: Linear
order: 69
category: Hub
---

# Linear triggers

First [connect a Linear app](/docs/hub/self-hosting/linear-app) to your self-hosted Hub.

| Event                        | When it runs                                                              |
| ---------------------------- | ------------------------------------------------------------------------- |
| `linear.comment_created`     | A new comment matches the configured author and text filters.             |
| `linear.issue_assigned`      | An update assigns or reassigns the issue to a user.                       |
| `linear.issue_entered_scope` | An issue is created in scope or changes from outside to inside the scope. |

In each event, set `connection` to the Hub connection slug. Scope an issue with `filters.project`, `states`, `assignees`, `labels`, and `exclude_labels` as needed. Every listed required label must be present, and any excluded label prevents a match. These filters use Linear IDs. Use **Copy model UUID** in Linear's command menu or look up the IDs in the [Linear API](https://linear.app/developers/graphql).

Use `from_users` to name the allowed comment authors or users who make an assignment. It's required for comment and assignment triggers. For comments, `pattern` matches a prefix and `contains` matches a substring.

`linear.issue_entered_scope` requires `project` and can omit `from_users` for an automatic workflow. It runs when an issue enters scope. Issues already in scope wait for a new transition.

## Deploy a trigger

Save this as `.paseo/triggers/linear-help.yml`. Replace the connection slug and user UUID and set the target to a [connected daemon](/docs/hub/daemons) that can run agents. Use a provider and mode your daemon offers.

```yaml
name: linear-help
on:
  linear.comment_created:
    connection: acme-linear
    filters:
      from_users: ["11111111-1111-4111-8111-111111111111"]
      pattern: "/paseo "
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
    options:
      approval_policy: never
      sandbox_mode: read-only
  max_runtime: 20m
  prompt: |
    Summarize the request and suggest a next step.
    Post one reply using hub.reply, then call hub.finish_execution.
    ${{ paseo.prompt }}
  outputs:
    linear.reply:
      max: 1
      required: true
```

Run `paseo hub deploy --dry-run`, then `paseo hub deploy`. From an allowed Linear account, write a new issue comment such as `/paseo summarize this request`. The prefix matches the comment text, and `hub.reply` posts a comment to the originating issue. Check [Activity](/docs/hub/activity) for the run.
