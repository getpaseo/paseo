---
title: GitHub access
description: Grant a Hub trigger a scoped GitHub installation token and isolated git configuration.
nav: GitHub access
order: 72
category: Hub
---

# GitHub access

A trigger grants no `GH_TOKEN` or git push authority by default. Add a `run.github` block to any trigger whose agent needs `git` or `gh` access to push branches, open pull requests, or edit issues:

```yaml
name: implement-request
on:
  github.issue_comment_created:
    connection: acme-github
    filters:
      repo: acme/project
      contains: "@paseo"
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
      pull_requests: write
  prompt: |
    Implement the request, push a branch, and open a pull request with gh.
    Reply with the PR link using reply, then call finish_execution.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
```

`run.github` works on any trigger source, including Linear, Slack, Discord, schedules, and webhooks.

## Fields

| Field          | Notes                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`   | GitHub integration slug from **Integrations**.                                                                                                |
| `repositories` | Repositories the token can reach. On a GitHub-triggered run, this defaults to the triggering repository. Required for other events.           |
| `permissions`  | Installation-token permissions such as `contents`, `pull_requests`, and `issues` (`read`, `write`, or `admin`). Defaults to `contents: read`. |
| `duration`     | Positive token lifetime up to `1h`. Defaults to `1h`, GitHub's maximum.                                                                       |

Requested permissions cannot exceed what the GitHub App installation allows.

When you save or deploy a trigger, Hub validates the `run.github` schema, any GitHub event filters (`on.github.*`), and the agent configuration. Hub looks up `run.github.connection` and mints the installation token when the run launches, so a nonexistent slug, unreachable repository, or excess permission fails at launch rather than at deploy time.

## Agent environment

When `run.github` is present, Hub mints a short-lived GitHub App installation token and injects `GH_TOKEN` plus process-scoped git configuration into the agent environment:

- Commits use the App bot login as `user.name` and `<app-id>+<bot-login>@users.noreply.github.com` as `user.email`.
- `git@github.com:` and `ssh://git@github.com/` remotes rewrite to HTTPS.
- `gh auth git-credential` supplies credentials for git operations.
- User-global and system git configuration are ignored, and interactive credential prompts are disabled.
- The daemon host's own git identity and SSH credentials are not read or changed.

`GH_TOKEN` and Hub's git configuration variables are reserved when `run.github` is configured, so `run.env` cannot overwrite them.

## Continuation and token lifecycle

With `run.github` or a connection token in `run.env`, follow-ups on an active continuing agent share the leased token until all active requests finish. Hub then revokes leased tokens, and the next arrival starts a fresh agent with a new token. For scheduled or webhook triggers with temporary GitHub tokens, prefer `continuation: { mode: new }`.

## Other connection values

You can pass values from other organization connections into an agent's environment explicitly with `run.env`:

```yaml
run:
  env:
    SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

Hub resolves the expression when preparing the agent environment. See [Hub security](/docs/hub/security) for host and permission boundaries.
