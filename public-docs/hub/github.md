---
title: GitHub access
description: Grant one workflow step a scoped GitHub token and git setup.
nav: GitHub access
order: 65
category: Hub
---

# GitHub access

A trigger grants no GitHub credential. Put a `github` block on the step that needs repository authority:

```yaml
name: implement-request
on: github.issue_comment
max_runtime: 2h
filters:
  repo: example/project
  contains: "@paseo"
  from_users: [maintainer]
steps:
  - id: implement
    environment: development
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
          Implement the request, push a branch, and open a pull request with gh.
          Call hub.finish_execution when done.
          ${{ paseo.prompt }}
```

The agent can use `git` and `gh` within the declared repositories and permissions. Hub mints the token when the step starts and revokes it when execution ends.

## Fields

| Field          | Notes                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`   | Project GitHub connection slug.                                                                                                        |
| `repositories` | Repositories the token can reach. On a GitHub-triggered run, this defaults to the triggering repository. Required for other providers. |
| `permissions`  | Installation-token permissions such as `contents`, `pull_requests`, and `issues`. Defaults to `contents: read`.                        |
| `duration`     | Positive token lifetime up to `1h`. Defaults to `1h`, GitHub's maximum.                                                                |

Requested authority cannot exceed the GitHub App installation. Activation and dispatch fail clearly when the connection, repository, or permissions cannot be resolved.

## Agent environment

Hub supplies `GH_TOKEN` and process-scoped git configuration through environment variables:

- Commits use the App bot login as `user.name` and `<app-id>+<bot-login>@users.noreply.github.com` as `user.email`.
- `git@github.com:` and `ssh://git@github.com/` remotes are rewritten to HTTPS.
- `gh auth git-credential` handles GitHub credentials for the step.
- User-global and system git configuration are ignored, and terminal credential prompts are disabled.
- The daemon host's git identity and credentials are not read or changed.

`GH_TOKEN` and Hub's git configuration variables are reserved when a step has a `github` block; workflow `env` cannot replace them.

## Keep authority on the worker

A classifier can read untrusted request text without GitHub authority. Put the `github` block only on the later branch that makes a change. [Workflow routing](/docs/hub/workflows#route-from-a-classifier) shows the ordered classifier/worker shape.

Connection values for other integrations remain explicit step environment values:

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

Hub resolves the value for the step and does not persist it. See [Hub security](/docs/hub/security) for provider and host boundaries.
