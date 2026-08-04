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

On the machine:

```sh
paseo hub connect https://hub.example.com
```

The CLI prints a URL and a verification code, and opens your browser if it can. In Hub, open **Daemons → Register a daemon**, enter the code, name the daemon, and approve it.

The name you choose here is what configuration references. It can be renamed later, but renaming after a configuration is active means updating that configuration.

For unattended setup, skip the browser with an enrollment token:

```sh
paseo hub connect https://hub.example.com --token <token>
```

Check and undo:

```sh
paseo hub status
paseo hub disconnect
paseo hub disconnect --force   # drop local authority when Hub is unreachable
```

One daemon has one Hub relationship. Connecting a daemon that already has one is refused.

## Reference it from configuration

```yaml
environments:
  - name: dev
    kind: daemon
    daemon: my-macbook
    cwd: /Users/you/code/your-repo
```

`daemon` is the display name. It resolves to a daemon id when the configuration activates, so a daemon that no longer exists fails activation instead of failing at dispatch.

`cwd` is a path on that machine. Hub does not clone anything for you; the directory must already exist.

To keep executions off your working tree, add a worktree:

```yaml
worktree:
  mode: branch-off
  newBranch: hub/${{ paseo.event.github.issue.number }}
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
