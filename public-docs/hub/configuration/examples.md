---
title: Hub examples
description: Copyable hub.yml configurations for issue triage, PR review, Discord and Slack mentions, and isolated worktrees.
nav: Examples
order: 70
category: Hub
---

# Hub examples

Complete configurations you can adapt. Field details are in the [`hub.yml` reference](/docs/hub/configuration/hub-yml).

Every example assumes one environment:

```yaml
environments:
  - name: dev
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/api
```

## Answer a mention on an issue

The baseline. An agent runs in your checkout and can push, because GitHub-triggered executions get a scoped `GH_TOKEN`.

```yaml
triggers:
  - name: mention
    on: github.issue_comment
    environment: dev
    filters:
      repo: acme/api
      contains: "@paseo"
      from_users: [alice, bob]
    agent:
      provider: codex
      mode: full-access
    prompt: |
      You were mentioned on ${{ paseo.event.github.trigger_url }}.

      ${{ paseo.event.github.comment.body }}

      Reply by commenting on the thread with gh.
```

## Review a pull request in its own worktree

`checkout-branch` on the PR's head branch puts the agent on the right code without disturbing your working tree.

```yaml
triggers:
  - name: review
    on: github.pull_request_review_comment
    environment: review
    filters:
      repo: acme/api
      contains: "@paseo review"
      from_users: [alice]
    agent:
      provider: claude
      mode: full-access
    timeout: 30m
    auto_archive: true
    prompt: |
      Address this review comment on PR #${{ paseo.event.github.pull_request.number }}:

      ${{ paseo.event.github.comment.body }}
```

Add the worktree to the environment it uses:

```yaml
environments:
  - name: review
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/api
    worktree:
      mode: checkout-branch
      branch: ${{ paseo.event.github.pull_request.head.ref }}
```

## Triage new issues on a fresh branch

```yaml
environments:
  - name: triage
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/api
    worktree:
      mode: branch-off
      newBranch: triage/${{ paseo.event.github.issue.number }}
      base: main

triggers:
  - name: triage
    on: github.issues
    environment: triage
    filters:
      repo: acme/api
      from_users: [alice, bob]
    agent:
      provider: codex
      mode: full-access
    prompt: |
      Investigate issue #${{ paseo.event.github.issue.number }}:
      ${{ paseo.event.github.issue.title }}

      ${{ paseo.event.github.issue.body }}

      If you find the cause, open a pull request.
```

## Discord mention with repository access

The trigger fires from Discord, so the GitHub token has to be requested by connection slug.

```yaml
triggers:
  - name: discord
    on: discord.mention
    environment: dev
    filters:
      guild: "123456789012345678"
      from_users: ["345678901234567890"]
    agent:
      provider: codex
      mode: full-access
    env:
      GH_TOKEN: ${{ paseo.connections.acme-github.token }}
    allow_outputs:
      - type: discord.reply
    prompt: |
      ${{ paseo.event.discord.trigger_message.body }}

      Reply in the thread when you are done.
```

## Slack mention that replies in-thread

```yaml
triggers:
  - name: slack
    on: slack.mention
    environment: dev
    filters:
      workspace: T01234567
      channels: [C01234567]
      from_users: [U01234567]
    agent:
      provider: codex
      mode: full-access
    idle_timeout: 10m
    allow_outputs:
      - type: slack.reply
    prompt: ${{ paseo.event.slack.trigger_message.body }}
```

## One trigger, several repositories

Omit `repo` and the trigger listens to every repository the GitHub connection can see. Pin the connection when the organization has more than one.

```yaml
triggers:
  - name: any-repo
    on: github.issue_comment
    environment: dev
    filters:
      connection: acme-github
      contains: "@paseo"
      from_users: [alice]
    agent:
      provider: codex
      mode: full-access
    prompt: |
      ${{ paseo.event.github.repository_full_name }}:
      ${{ paseo.event.github.comment.body }}
```

`cwd` is fixed per environment, so a trigger like this makes sense when the agent works from a token rather than a checkout.
