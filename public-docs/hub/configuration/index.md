---
title: Hub configuration
description: Generate, edit, and deploy organization triggers from your repository.
nav: Configuration
order: 70
category: Hub
---

# Hub configuration

Each organization trigger is one self-contained YAML file. Keep triggers in your repository and deploy them with `paseo hub deploy`:

```text
.paseo/
└── triggers/
    └── <trigger>.yml
```

## Generated starter trigger

Run `paseo hub init` from the repository the agent should work in. Setup selects an app connection and an available agent runtime, asks which user may trigger it, validates the result, and writes one file. It then asks whether to deploy. Interactive `paseo hub login` connects the daemon and points to this command; it does not write trigger files.

For a Slack connection named `my-team`, the generated document looks like this:

```yaml
# .paseo/triggers/slack-help.yml
name: slack-help
enabled: true
on:
  slack.mention:
    connection: my-team
    filters:
      from_users: [U01234567]
max_runtime: 2h
run:
  target:
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
  agent:
    provider: codex
    model: gpt-5
    mode: full-access
  continuation:
    mode: conversation
  max_runtime: 90m
  idle_timeout: 10m
  prompt: |
    Answer with hub.reply, then complete this request and call hub.finish_execution when done.

    <user-prompt>
    ${{ paseo.prompt }}
    </user-prompt>
  outputs:
    slack.reply:
      max: 1
      required: true
```

`connection` is the app connection's slug in your organization. `target.daemon` is the connected daemon's slug and `target.cwd` is the absolute directory where you ran setup. `agent` contains the provider, model, and execution mode you selected from the daemon. The mode is required.

`continuation.mode: conversation` keeps follow-ups in the same provider conversation on the same agent. The prompt asks the agent to reply and then call `hub.finish_execution`; replying alone does not finish the execution.

A Discord starter uses `discord.mention`, your Discord user ID, and `discord.reply`. A GitHub starter uses `github.issue_comment`, restricts the repository to the current GitHub remote, and requires both `@paseo` and your GitHub username. GitHub's starter has no explicit reply output declaration.

Setup asks before replacing the selected trigger file. It preserves other triggers and any existing legacy bundle. Read [Hub security](/docs/hub/security) before widening `from_users` or the agent's authority.

## Deploy from the CLI

Run from the repository root:

```sh
paseo hub login https://hub.example.com
paseo hub deploy --dry-run
paseo hub deploy
```

Both deploy commands discover direct `.paseo/triggers/*.yml` files in deterministic path order. The CLI rejects nested files, `.yaml` extensions, symlinked trigger paths, and unreadable files. It does not search parent directories.

Dry-run validates each document against Hub without storing a revision. Deployment validates all documents first, then installs them one at a time through the organization trigger API. Installation creates or updates a trigger by its YAML `name`. If a later install fails, the error lists the files already installed; those revisions remain active. Errors name paths without printing file contents or credentials.

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

## Legacy project bundles

Existing project bundles use `.paseo/hub.yml`, direct `.paseo/workflows/*.yml` files, and referenced files below `.paseo/workflows/partials/`. `hub.yml` owns named environments and agents; each workflow owns its trigger and ordered steps.

Select the legacy deployment path explicitly:

```sh
paseo hub deploy --project my-project --dry-run
paseo hub deploy --project my-project
```

These commands send the complete bundle through the project configuration API. Dry-run validates without recording or activating a revision. `paseo hub init` does not create or migrate these bundles.

The following source and revision behavior applies to legacy project bundles.

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
