---
title: Daemons in Hub
description: Enroll a machine with Hub, reference it from configuration, and understand what Hub owns once it is connected.
nav: Daemons
order: 63
category: Hub
---

# Daemons in Hub

A daemon is one of your machines running the Paseo daemon. Enroll it once with your Hub organization, then any project can reference it.

## Connect

Log in from the machine first:

```sh
paseo hub login https://hub.example.com
```

The CLI prints a URL and verification code, opens your browser when the terminal is interactive, and stores the approved organization-scoped CLI credential under `PASEO_HOME`. Then enroll the daemon:

```sh
paseo hub connect
```

`connect` resolves the active login's Hub origin and uses its credential to request a short-lived, single-use enrollment token. The daemon exchanges that token and retains its own independently generated relationship credential. The human CLI credential is never stored as daemon authority.

Each daemon has two identifiers: an immutable generated ID and a friendly slug. Hub normalizes the slug you enter with lowercase words joined by hyphens, so `Build Studio` becomes `build-studio`. The slug is what the dashboard shows and what configuration references.

You can rename the slug later without changing the daemon ID. Renaming after a configuration is active means updating that configuration.

For unattended setup, pass an organization API key without storing it:

```sh
PASEO_HUB_URL=https://hub.example.com PASEO_HUB_API_KEY=paseo_pk_... paseo hub connect
```

Origin precedence is explicit `[origin]`, `PASEO_HUB_URL`, active stored login, then `https://hub.paseo.sh`. An explicit `--api-key <secret>` takes precedence over the environment and an exact-origin stored login.

Check and undo:

```sh
paseo hub status
paseo hub disconnect
paseo hub disconnect --force   # drop local authority when Hub is unreachable
```

One daemon has one Hub relationship. Connecting a daemon that already has one is refused.

`paseo hub logout` removes only the active human CLI credential. In an interactive terminal, it checks the relationship and offers to disconnect when the daemon uses the same Hub. It performs an accepted disconnect before deleting the login, so a failed disconnection preserves the human credential. Declining leaves the daemon connected and removes only the login. JSON and noninteractive logout never disconnect implicitly; use `paseo hub logout --disconnect-daemon` when automation intends to remove both identities. Add `--force` only when that daemon disconnection should remove local authority while Hub is unreachable.

## Reference it from configuration

```yaml
environments:
  - name: dev
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
```

`daemon` is the friendly slug. It resolves to the immutable daemon ID when the configuration activates, so a daemon that no longer exists fails activation instead of failing at dispatch.

`cwd` is a path on that machine. Hub does not clone anything for you; the directory must already exist.

To keep executions off your working tree, add a worktree:

```yaml
worktree:
  mode: branch-off
  newBranch: hub/investigation
  base: main
```

See [Git worktrees](/docs/worktrees) for setup hooks and scripts.

## What Hub owns

For agents it dispatched, Hub owns creation, reconnect recovery, output observation, and completion. Agents you start yourself are untouched.

If Hub loses the create response, or the daemon restarts mid-execution, Hub resends the same create intent with the same execution id. The daemon returns the existing agent rather than running the prompt again. An agent that closed or errored is recorded as interrupted; Hub never silently starts a second one.

## Status

| Status            | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| Approval required | The CLI is waiting for you to approve the code |
| Connected         | Online and accepting dispatch                  |
| Offline           | Enrolled but not currently connected           |
| Revoked           | Access removed from Hub                        |

An event that arrives while a daemon is offline fails dispatch with `daemon_not_connected`. Nothing is queued for later. The event is in the project's Activity, and the trigger has to fire again.

Revoking from **Daemons → Revoke daemon** ends the relationship from Hub's side. The daemon keeps running your local agents.
