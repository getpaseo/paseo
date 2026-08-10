---
title: Hub quickstart
description: Connect Hub, create a project, and run a workflow from a GitHub comment.
nav: Quickstart
order: 61
category: Hub
---

# Hub quickstart

## 1. Create a project

Open **Connections** in Hub and connect the GitHub account or organization whose repositories you use. Then open **Projects → New project** and create a project.

## 2. Log in and connect a daemon

On the machine that will run agents:

```sh
paseo hub login https://your-hub.example.com
paseo hub projects
paseo hub connect
```

Approve the browser login. `projects` shows the slug needed by `deploy`. See [Daemons](/docs/hub/daemons) for the separation between your CLI login and the daemon relationship.

## 3. Add the bundle

Create these files:

```text
.paseo/
├── hub.yml
└── workflows/
    └── github-help.yml
```

`.paseo/hub.yml` names project-wide resources:

```yaml
environments:
  dev:
    kind: daemon
    daemon: my-daemon
    cwd: /Users/you/code/your-repo
agents:
  codex:
    provider: codex
    mode: full-access
```

`.paseo/workflows/github-help.yml` contains one trigger and its ordered steps:

```yaml
name: github-help
on: github.issue_comment
max_runtime: 2h
filters:
  repo: yourname/your-repo
  contains: "@paseo"
  from_users: [your-github-login]
steps:
  - id: work
    environment: dev
    max_runtime: 90m
    idle_timeout: 10m
    agent: codex
    prompt:
      - text: |
          Complete this request and call hub.finish_execution when done.

          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
```

`daemon` is the daemon slug shown by Hub. `cwd` is a directory on that machine. `${{ paseo.prompt }}` is the normalized request text after the provider marker and declared input headers are removed.

Workflow files are discovered as direct `.yml` children of `.paseo/workflows/`. You do not list them in `hub.yml`.

## 4. Validate and deploy

From the project root:

```sh
paseo hub deploy -p your-project --dry-run
paseo hub deploy -p your-project
```

Dry-run performs the same discovery and server-side validation without recording or activating a revision. See [Configuration](/docs/hub/configuration) for credentials, diagnostics, and GitHub sync.

## 5. Trigger it

Comment from the account in `from_users`:

```text
@paseo have a look at this
```

Open the project's **Activity** tab to see routing and execution. If nothing runs, use the [Activity checklist](/docs/hub/activity).

Before widening the allowlist or granting write authority, read [Hub security](/docs/hub/security).

When you no longer need the local CLI login:

```sh
paseo hub logout
```

Logging out does not disconnect the daemon. When the daemon is connected to the same Hub as the active CLI login, use `paseo hub logout --disconnect-daemon` to remove both relationships.
