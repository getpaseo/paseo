---
title: Hub configuration
description: Author, validate, and deploy self-contained triggers from your repository with the Paseo CLI.
nav: Configuration
order: 73
category: Hub
---

# Hub configuration

Each Hub trigger is one self-contained YAML file. Edit triggers in the Hub dashboard under **Triggers**, or keep them in your repository and deploy them with `paseo hub deploy`:

```text
.paseo/
└── triggers/
    └── <trigger>.yml
```

See the [Trigger YAML reference](/docs/hub/configuration/reference) for every supported field.

## Generated starter trigger

Run `paseo hub init` from the repository where the agent will work. Setup connects your daemon if needed, lets you choose a ready integration and an available agent runtime from that daemon, asks which user can trigger the bot, validates the result, and writes one starter file. It then asks whether to deploy.

For a Slack integration named `my-team`, setup generates:

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

`connection` is the integration slug in your organization. `target.daemon` is your connected daemon's slug and `target.cwd` is the absolute repository path. `agent` carries the provider, model, and mode selected from that daemon.

`continuation.mode: conversation` keeps follow-up mentions in the same thread on the same agent. The prompt instructs the agent to reply and call `finish_execution` because replying alone does not end the run.

A Discord starter uses `discord.mention`, your Discord user ID, and `discord.reply`. A GitHub starter uses `github.issue_comment`, scopes `repo` to the current GitHub remote, and requires both `@paseo` and your GitHub username.

Setup asks before replacing an existing starter file and leaves other trigger files untouched. Read [Hub security](/docs/hub/security) before widening `from_users` or agent authority.

## Startup timeout

Hub waits up to 2 minutes by default for an agent to start, including worktree creation, provider startup, and initial prompt acceptance. On a slower machine or large repository, set `run.startup_timeout`:

```yaml
name: inspect
on:
  manual.run: {}
run:
  target:
    daemon: devbox
    cwd: /workspace/project
  agent:
    provider: codex
    mode: full-access
  startup_timeout: 5m
  prompt: Inspect this repository and summarize its current state. Call finish_execution when done.
```

Use a positive duration in `ms`, `s`, `m`, or `h`, up to `24h`. `max_runtime` and `idle_timeout` still apply during startup and can expire sooner.

## Deploy from the CLI

Run from the repository root:

```sh
paseo hub login https://hub.example.com
paseo hub deploy --dry-run
paseo hub deploy
```

Both commands read every direct `.paseo/triggers/*.yml` file in deterministic path order. The CLI rejects nested directories, `.yaml` extensions, symlinks, and unreadable files, and does not search parent directories.

`--dry-run` validates every file against Hub and your connected daemons without writing revisions. `paseo hub deploy` validates all files first, then installs each trigger by its YAML `name`.

If a later trigger fails to install, the error lists the files already installed. Redeploying an existing webhook trigger name preserves its webhook URL and secret.

Origin precedence:

1. Explicit command origin or `--hub`
2. `PASEO_HUB_URL`
3. Active stored CLI login
4. `https://hub.paseo.sh`

Credential precedence:

1. `--api-key`
2. `PASEO_HUB_API_KEY`
3. Stored CLI login for the exact resolved origin

Flags and environment API keys are never written to disk.

Next: [Trigger YAML reference](/docs/hub/configuration/reference).
