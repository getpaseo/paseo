# Worktrunk plugin example

Delegates Paseo worktree creation, removal, and restoration to [Worktrunk](https://worktrunk.dev) (`wt`), and updates `wt list` activity markers (`🤖` / `💬`) as agents run.

## What it does

- **Create:** routes branch-off, branch checkout, and change-request (PR/MR) creation through `wt switch --no-cd --format=json` (using Paseo's fetched `headSha` for PR/MR checkouts, and `--no-hooks` on untrusted fork checkouts) so Worktrunk controls placement, branch setup, and `pre-start` / `post-start` hooks. Local branch collisions decline and fall back to Paseo's Git checkout.
- **Remove:** routes archive and creation rollback through `wt remove --foreground --no-delete-branch --yes` so Worktrunk runs `pre-remove` and `post-remove` hooks while keeping the branch for Paseo's restore flow.
- **Restore:** routes archived worktree restoration through `wt switch --path <recorded-path>` for branch restores, and falls back to Paseo for detached-commit restores.
- **Activity markers:** sets `🤖` when an agent turn starts, `💬` when a turn ends or awaits permission, and clears the marker on close or archive. Background helpers are skipped.

## Prerequisites

Use [Worktrunk v0.82.0](https://github.com/max-sixty/worktrunk/releases/tag/v0.82.0) with Git 2.43.0 or later on the daemon host.

Install Worktrunk (`wt`, or `git-wt.exe` on Windows) on `PATH`, or set `WORKTRUNK_BIN` in the daemon environment.

## Install

```bash
paseo plugin install /absolute/path/to/plugin-examples/worktrunk
```
