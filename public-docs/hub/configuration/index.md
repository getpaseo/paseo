---
title: Hub configuration
description: Configuration bundles, GitHub sync, CLI deployment, and revisions.
nav: Configuration
order: 70
category: Hub
---

# Hub configuration

A project configuration is one versioned bundle:

```text
.paseo/
├── hub.yml
└── workflows/
    ├── <workflow>.yml
    └── partials/
        └── <partial>.md
```

`hub.yml` owns named environments and agents. Each direct-child workflow file owns one trigger and its ordered inline steps. Prompt partials referenced by those workflows live below `workflows/partials/`. Workflow discovery is fixed by convention; there is no manifest or include list.

[single-repo-team-bot](https://github.com/getpaseo/hub/tree/main/examples/single-repo-team-bot) is a complete bundle in this shape: Discord, Slack, and GitHub workflows running a classifier and a worker on shared partials. Copy `.paseo/` into your repository and replace the placeholders its README lists.

## Generated starter bundle

`paseo hub init`, and the guided setup that interactive `paseo hub login` offers, write two files for the directory you run them in:

```yaml
# .paseo/hub.yml
environments:
  my-macbook:
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
agents:
  starter:
    provider: codex
    model: gpt-5
    mode: full-access
```

The environment is named after the connected daemon and points at the directory setup ran in. `provider`, `model`, and `mode` are the runtime you chose from what that daemon reported, so the starter agent is a complete selection before its first run. `mode` is omitted for a provider that exposes none.

```yaml
# .paseo/workflows/slack-help.yml
name: slack-help
on: slack.mention
max_runtime: 2h
filters:
  workspace: T01234567
  from_users:
    - U01234567
steps:
  - id: work
    environment: my-macbook
    max_runtime: 90m
    idle_timeout: 10m
    agent: starter
    prompt:
      - text: |
          Answer with hub.reply, then complete this request and call hub.finish_execution when done.

          <user-prompt>
          ${{ paseo.prompt }}
          </user-prompt>
    allow_outputs:
      - type: slack.reply
        max: 1
        required: true
```

`filters` carries provider-native identifiers: the Slack team and member ID above, the Discord guild and user ID for a Discord starter, and `owner/name` plus your login for GitHub. A Discord starter is `discord-help.yml` and a GitHub starter is `github-help.yml`, each with the reply capability its provider supports.

The generated workflow allows one user in one workspace. Read [Hub security](/docs/hub/security) before widening it.

## Sources

A configuration comes from one source:

- **GitHub source**: the complete `.paseo` bundle on the repository's default branch.
- **Manual source**: source files edited and activated in the dashboard.
- **CLI/API install**: a complete bundle sent with organization authority.

The **Configuration** tab shows the active revision, source files, and latest synchronization attempt.

## Deploy from the CLI

Run from the project root:

```sh
paseo hub login https://hub.example.com
paseo hub deploy -p my-project --dry-run
paseo hub deploy -p my-project
```

Both commands discover `.paseo/hub.yml`, every direct `.paseo/workflows/*.yml` file, and each referenced file below `.paseo/workflows/partials/`. Files are sent in deterministic path order through the same bundle request. Dry-run calls server-side validation and does not create or activate a revision.

The CLI rejects missing resource or workflow files, `.yaml` workflow extensions, nested workflow files, unsafe partial paths, symlinked bundle paths, and unreadable files before contacting Hub. Errors name paths but never print file contents or credentials.

Origin precedence:

1. `--hub`
2. `PASEO_HUB_URL`
3. Active stored login
4. `https://hub.paseo.sh`

Credential precedence:

1. `--api-key`
2. `PASEO_HUB_API_KEY`
3. Stored login for the exact resolved origin

Flags and environment keys are not stored. Endpoint and credential behavior is unchanged between deploy and dry-run.

## GitHub sync

A push to the configuration repository's default branch starts a sync:

1. Hub discovers the canonical bundle at that exact commit.
2. It parses every source file and resolves prompt partials.
3. It validates named resources, expressions, connections, and daemon availability.
4. On success, the new immutable revision becomes active.

**Sync now** performs the same operation on demand. Failures retain their source path and authored field. A failed sync never replaces the active revision.

## Revisions and source changes

Revisions retain the exact authored files needed to inspect or redeploy them. Rolling back activates an earlier revision. The next valid GitHub push activates a new revision again.

GitHub-backed configuration is read-only in the dashboard. Switching to manual preserves source documents; it does not collapse the bundle into one generated file.

The configuration repository may differ from repositories named by `filters.repo`. Protect it because changing the bundle can select connections, daemons, working directories, agents, and outputs. See [Hub security](/docs/hub/security).

Next: the [configuration reference](/docs/hub/configuration/hub-yml) and [workflow examples](/docs/hub/workflows).
