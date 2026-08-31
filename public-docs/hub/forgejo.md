---
title: Forgejo access
description: Grant one workflow step repository-limited Forgejo authority and Git setup.
nav: Forgejo access
order: 65.5
category: Hub
---

# Forgejo access

A trigger grants no Forgejo credential. Put a `forgejo` block on the step that needs repository
authority:

```yaml
name: implement-request
on: forgejo.issue_comment_created
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
    forgejo:
      connection: example-forgejo
      repositories: [example/project]
      contents: write
      issues: write
    prompt:
      - text: |
          Implement the request, push a branch, and open a pull request.
          Call hub.finish_execution when done.
          ${{ paseo.prompt }}
```

An organization owner configures a repository-limited execution PAT for the connection. Hub
checks the connection, enrolled repositories, and requested capability before it materializes the
PAT for the running step. Hub does not create, expand, or silently replace the upstream PAT.
Forgejo personal access tokens cannot be attenuated: after the step grant is shown to be a subset
of that PAT, Hub injects the stored execution PAT as `FORGEJO_TOKEN`.

## Fields

| Field          | Notes                                                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `connection`   | Active Forgejo connection slug in the workflow organization.                                                                  |
| `repositories` | Enrolled `owner/name` repositories the step may reach. Defaults to the triggering repository only on a Forgejo-triggered run. |
| `contents`     | `read` or `write` repository-content capability. Defaults to `read`.                                                          |
| `issues`       | `read` or `write` issue, comment, and reaction capability. Defaults to `read`.                                                |

For a non-Forgejo trigger, `repositories` is required. Requested repositories and capabilities cannot
exceed the enrolled repository list or the execution PAT. A step cannot declare both `github` and
`forgejo` authority.

## Agent environment

Hub supplies `FORGEJO_TOKEN` and process-scoped Git configuration only to the step with a
`forgejo` block:

- Commits use the connected Forgejo identity.
- Git remotes for the approved Forgejo origin are rewritten to HTTPS.
- Git credentials read `FORGEJO_TOKEN` at use time.
- User-global and system Git configuration are ignored, and terminal credential prompts are disabled.
- The daemon host's Git identity and credentials are not read or changed.

`FORGEJO_TOKEN` and Hub's Git configuration variables are reserved when a step has a `forgejo`
block; workflow `env` cannot replace them. The token is not retained in the workflow definition,
durable launch data, logs, or diagnostics.

## Keep authority on the worker

A classifier can read untrusted request text without Forgejo authority. Put the `forgejo` block
only on the later branch that makes a change. [Workflow routing](/docs/hub/workflows#route-from-a-classifier)
shows the ordered classifier/worker shape.

Configure the connection and execution PAT through [Forgejo for Hub](/docs/hub/self-hosting/forgejo).
Connection values for other integrations remain explicit step environment values:

```yaml
env:
  SOME_TOKEN: "${{ paseo.connections.some-connection.token }}"
```

Hub resolves the value for the step and does not persist it. See [Hub security](/docs/hub/security)
for provider and host boundaries.
