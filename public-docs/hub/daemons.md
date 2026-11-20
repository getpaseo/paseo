---
title: Daemons in Hub
description: Enroll a Paseo daemon with Hub, grant execution permission, and target it from triggers.
nav: Daemons
order: 63
category: Hub
---

# Daemons in Hub

A daemon is one of your machines running the Paseo daemon. Enroll it once with your Hub organization, grant execution permission, and reference its slug in your triggers.

## Connect a daemon

Log in from the machine first:

```sh
paseo hub login https://hub.example.com
```

The CLI prints a URL and verification code and opens your browser. After approval, Paseo stores an organization-scoped CLI login under `PASEO_HOME`.

In an interactive terminal, `login` offers to connect this daemon and separately asks whether to allow Hub automations to run agents. Connection defaults to yes, and execution permission defaults to no. `--json` and non-TTY logins do not prompt.

If you skipped connection during login, enroll the daemon separately:

```sh
paseo hub connect
```

`connect` uses your active login to request a single-use enrollment token. The daemon exchanges that token for its own relationship credential, so your CLI login is never stored as daemon authority.

Hub derives the daemon's initial slug from its hostname using lowercase words joined by hyphens, such as `build-studio`. If that slug is already taken in the organization, Hub appends a short daemon ID suffix.

You can rename the slug later in Hub without changing the immutable daemon ID, then update any triggers that reference the old slug.

For unattended setup, pass an organization API key through the environment:

```sh
PASEO_HUB_URL=https://hub.example.com PASEO_HUB_API_KEY=paseo_pk_... paseo hub connect
```

Origin precedence is explicit `[origin]` or `--hub`, then `PASEO_HUB_URL`, then the active stored login, then `https://hub.paseo.sh`. An explicit `--api-key <secret>` takes precedence over environment variables and stored logins.

Check status or disconnect a daemon:

```sh
paseo hub status
paseo hub disconnect
paseo hub disconnect --force   # drop local authority when Hub is unreachable
```

One daemon connects to one Hub organization at a time. Connecting a daemon that already belongs to a Hub is refused.

`paseo hub logout` removes the stored CLI login. In an interactive terminal, it offers to disconnect a daemon connected to the same Hub first. In `--json` or non-interactive mode, `logout` never disconnects the daemon unless you pass `--disconnect-daemon`:

```sh
paseo hub logout --disconnect-daemon
paseo hub logout --disconnect-daemon --force
```

## Grant execution permission

Enrolling a daemon does not allow Hub to start agents on it. Grant the `hub.execute` permission from that machine:

```sh
paseo hub permissions list
paseo hub permissions grant hub.execute
paseo hub permissions revoke hub.execute
```

Until `hub.execute` is granted, Hub tracks the daemon for identity and presence only. **Daemons** marks it as **Connected only** and **Home** notes that it cannot run agents. See [Choose daemon authority](/docs/hub/security#choose-daemon-authority) for what `hub.execute` permits.

## Target a daemon from a trigger

Reference the daemon slug and an existing working directory under `run.target`:

```yaml
name: repo-triage
on:
  manual.run: {}
run:
  target:
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
  agent:
    provider: codex
    mode: full-access
  prompt: Inspect the repository status and call hub.finish_execution.
```

`daemon` resolves to the immutable daemon ID when you save or deploy the trigger. `cwd` is an absolute path that already exists on that machine. Hub does not clone repositories for you.

To isolate each run on its own git branch instead of editing your working tree, add a `worktree` block:

```yaml
name: isolate-fix
on:
  manual.run: {}
run:
  target:
    daemon: build-server
    cwd: /workspace/project
    worktree:
      mode: branch-off
      newBranch: trigger-${{ paseo.execution.id }}
      base: origin/main
  agent:
    provider: codex
    mode: full-access
  prompt: Run tests and call hub.finish_execution.
```

`${{ paseo.execution.id }}` renders the execution UUID, giving each run a unique branch off `origin/main` that survives retries and recovery. See [Trigger YAML reference](/docs/hub/configuration/reference#target-and-worktree) and [Git worktrees](/docs/worktrees).

## Provider discovery

When you select a daemon and working directory in the Hub trigger editor, Hub asks that daemon for its configured providers, models, execution modes, and thinking options.

Hub works with any provider configured on your Paseo daemon, including Claude Code, Codex, OpenCode, Pi, and custom or plugin providers. When you save or deploy a trigger, the connected daemon validates the chosen provider settings so invalid values fail immediately.

## Recovery and ownership

For agents it dispatches, Hub owns creation, reconnect recovery, output tracking, and completion. Agents you start locally are untouched.

If Hub loses the create response or the daemon restarts mid-run, Hub resends the same create intent with the same execution ID. The daemon returns the existing agent instead of running the prompt twice. If an agent closes or crashes, Hub marks the run interrupted and does not silently start a second agent.

## Daemon status

| Status            | Meaning                                  |
| ----------------- | ---------------------------------------- |
| Approval required | The CLI is waiting for browser approval. |
| Connected         | Online and connected to Hub.             |
| Offline           | Enrolled, but not currently connected.   |
| Revoked           | Access was removed from Hub.             |

When a daemon is offline, saving a new trigger or changing a trigger's target or agent fails because Hub must check the agent configuration against that daemon. Editing only the prompt, filters, or runtime limits of an existing trigger still succeeds.

Revoking from **Daemons → Revoke daemon** ends the relationship from Hub's side while leaving local agents running.
