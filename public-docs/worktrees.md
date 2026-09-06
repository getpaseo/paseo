---
title: Git worktrees
description: Run agents in isolated git worktrees with setup hooks, scripts, and long-running services.
nav: Git worktrees
order: 11
category: Workspaces
---

# Git worktrees

Git worktrees are one kind of workspace.

A [workspace](/docs/workspaces) is the place where a task happens. When that workspace is backed by a git worktree, Paseo creates a separate directory on a separate branch so parallel agents never step on each other.

This page covers the git-specific details: where worktrees live, how branches are chosen, and how to configure setup hooks, scripts, terminals, and long-running services through `paseo.json`.

## Layout and workflow

Worktrees live under `$PASEO_HOME/worktrees/` by default, grouped by a hash of the source checkout path. You can change the base directory with `worktrees.root` in `config.json`. Each worktree gets a slug and a branch when its workspace is created.

```
~/.paseo/worktrees/
└── 1vnnm9k3/               # hash of source checkout path
    ├── tidy-fox/           # worktree slug
    └── bold-owl/
```

With a custom root, Paseo keeps the same hashed layout under that directory:

```json
{
  "worktrees": {
    "root": "/mnt/fast/paseo-worktrees"
  }
}
```

1. Create a workspace with worktree isolation, Paseo creates the worktree and runs your setup hooks
2. Launch one or more agents in that workspace
3. Review the diff against the base branch
4. Merge or archive the workspace; after the last workspace using it is archived, Paseo runs teardown and removes the worktree

## Create a worktree-backed workspace

The examples below use the current directory as the source checkout. Pass `--path ~/dev/my-app` to create the workspace from another checkout.

Branch off from a base branch:

```bash
paseo workspace create \
  --isolation worktree \
  --mode branch-off \
  --new-branch feature/auth \
  --worktree-slug feature-auth \
  --base origin/main
```

Use `origin/main` rather than `main`. Paseo fetches remote refs in the background, so the remote-tracking branch is current, while your local `main` is whatever you last pulled. An unqualified `main` resolves to that local branch first, and the worktree starts from stale history. Prefixing the remote names the fetched ref explicitly.

Check out an existing branch:

```bash
paseo workspace create \
  --isolation worktree \
  --mode checkout-branch \
  --branch feature/existing \
  --worktree-slug existing-copy
```

Or open a pull request in its own workspace:

```bash
paseo workspace create \
  --isolation worktree \
  --mode checkout-pr \
  --pr-number 2186
```

Add `--forge <name>` when Paseo cannot infer the forge from the source checkout.

## paseo.json

Drop a `paseo.json` in your repo root. Paseo reads it from the committed version of the base branch you picked, so uncommitted changes in other branches don't apply.

```json
{
  "worktree": {
    "setup": "npm ci",
    "teardown": "rm -rf .cache"
  },
  "scripts": {
    "test": { "command": "npm test" },
    "web": { "command": "npm run dev", "type": "service", "port": 3000 }
  }
}
```

## Setup and teardown

`setup` runs once after the worktree is created. A fresh worktree has no installed dependencies and no ignored files (like `.env`), so use setup to install and copy what you need. `teardown` runs during archive, before the directory is removed.

```json
{
  "worktree": {
    "setup": "npm ci\ncp \"$PASEO_SOURCE_CHECKOUT_PATH/.env\" .env\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}
```

Both fields accept a multiline shell script or an array of commands; commands run sequentially either way.

Commands run with the worktree as `cwd`. Use `$PASEO_SOURCE_CHECKOUT_PATH` to reach files in the original checkout (untracked config, local caches, etc).

## Local files

Open **Project Settings → Local files** on the destination host and select
**Import files**. Choose files from your device, or choose another connected host
and project. Your device does not need a local daemon or a checkout of the project.
Both hosts must be connected when copying from another host. Device imports use
the chosen filename: `~/code/app/.env` becomes `/srv/app/.env` when `/srv/app` is
the selected destination project. A host source must be a registered project,
but it does not have to be linked to the destination or use the same repository.

Review names, sizes, and destination status before importing. Small new files are
selected for you. Existing files remain unchecked; selecting one authorizes its
replacement. If a source or destination changes after inspection, select it again
to review the current copy. Values are never shown in the import preview.

Files must be Git-ignored and untracked in the destination project. Host sources
must also be ignored and untracked. Only individual regular files are supported:
no directories, globs, or symlinks. Imports are limited to 10 MiB per file,
25 MiB per selection, and 100 files. Device pickers start with files you choose;
Paseo does not scan your device for credentials. Host suggestions use configured
paths and common environment filenames without interpreting their contents.

Enable **Include in future worktrees** to merge the selected paths into
`paseo.json`:

```json
{
  "worktree": {
    "localFiles": [".env.local", "local/dev.pem"]
  }
}
```

Paths are relative to the selected project root, including projects within a repo
subdirectory. This edit is visible and uncommitted. The checked-out source
project's file list takes effect for new worktrees immediately; commit the list
to share that intent through Git with other hosts. Each host still needs its own
file contents. Setup commands continue to come from the worktree's selected
branch.

Configured files are copied before setup starts. Existing files in a worktree are
preserved, including when you run setup again. For an external change request,
files are withheld until you explicitly run setup, along with the other workspace
automation. If configured files are missing, workspace creation lets you import
first or explicitly continue without them; a setup script that requires those
files can still fail.

Imports update the destination project root. Existing worktrees are not updated,
and files do not synchronize in the background. If files arrive but saving
`paseo.json` fails, refresh the configuration in the import sheet and save inclusion
again without retransmitting successful files.

The client requires an encrypted relay connection, TLS, or loopback for file
contents. Imported files remain plaintext on the destination host and are readable
by its agents and scripts. Paseo creates files with owner-only permissions on
POSIX; Windows uses the destination's filesystem access controls.

## Scripts and services

`scripts` are named commands you can run inside a worktree on demand. Mark one as a _service_ and Paseo supervises it as a long-running process, assigns it a port, and routes HTTP traffic to it through the daemon's reverse proxy.

Run them from the app, or manage them from automation with [`paseo script`](/docs/cli#workspace-scripts) and the [workspace-script MCP tools](/docs/mcp#workspace-scripts).

### Plain scripts

```json
{
  "scripts": {
    "test": { "command": "npm test" },
    "lint": { "command": "npm run lint" },
    "generate": { "command": "npm run codegen" }
  }
}
```

### Services

```json
{
  "scripts": {
    "web": {
      "type": "service",
      "command": "npm run dev -- --port $PASEO_PORT",
      "port": 3000
    },
    "api": {
      "type": "service",
      "command": "npm run api -- --port $PASEO_PORT"
    }
  }
}
```

Omit `port` to let Paseo auto-assign one. Bind your process to `$PASEO_PORT` rather than hard-coding, each worktree gets a distinct port so multiple copies of the same service coexist.

### Dynamic port allocation

By default, Paseo asks the OS for an available ephemeral port. Configure a range globally in
`~/.paseo/config.json` or per project in `paseo.json`:

```json
// ~/.paseo/config.json
{
  "worktrees": {
    "servicePorts": { "range": "3000-4000" }
  }
}
```

```json
// paseo.json
{
  "worktree": {
    "servicePorts": { "range": "3000-4000" }
  }
}
```

The range is inclusive. A project `servicePorts` block replaces the global block. An explicit
service `port` always wins over either setting.

For an external allocator, configure `portScript` instead:

```json
{
  "worktree": {
    "servicePorts": { "portScript": "/usr/bin/portmake" }
  }
}
```

Paseo runs the executable in the workspace directory with four arguments: service name, workspace
ID, branch name, and worktree path. Since the script is executed directly without a shell, `portScript` must point to a real executable (such as a compiled binary or a script with a proper shebang line like `#!/bin/bash`) rather than an inline shell command or pipeline. If you need shell evaluation or pipelines, wrap them in a small executable script. A missing branch is passed as an empty string. The same values
are available as `PASEO_SCRIPTNAME`, `PASEO_WORKSPACE_ID`, `PASEO_BRANCH_NAME`, and
`PASEO_WORKTREE_PATH`. It must print one valid TCP port to stdout. `portScript` wins over `range` in
the same block. Paseo trusts the external allocator, so the returned port may already be in use, for
example by a service Paseo will attach to.

### Reverse proxy

Every service is reachable through the daemon at a deterministic hostname:

```
http://<script>--<branch>--<project>.localhost:<daemon-port>

# on the default branch, the branch label is dropped:
http://<script>--<project>.localhost:<daemon-port>
```

`*.localhost` resolves to `127.0.0.1` on modern systems, so these URLs work out of the box. The proxy supports WebSocket upgrades.

### Service-to-service

Services launched from the same workspace see each other's ports and proxy URLs. Given `web` and `api` above, each process gets:

```
PASEO_PORT=3000                         # this service's port
PASEO_URL=http://web--my-app.localhost:6767  # this service's proxy URL
PASEO_SERVICE_API_PORT=51732
PASEO_SERVICE_API_URL=http://api--my-app.localhost:6767
PASEO_SERVICE_WEB_PORT=3000
PASEO_SERVICE_WEB_URL=http://web--my-app.localhost:6767
```

Script names are upper-cased and non-alphanumerics become `_`. Point your frontend at `$PASEO_SERVICE_API_URL` instead of hard-coding a port.

## Terminals

Open terminals automatically when a worktree is created. Useful for tailing logs or leaving a REPL ready to go.

```json
{
  "worktree": {
    "terminals": [
      { "name": "logs", "command": "tail -f dev.log" },
      { "name": "shell", "command": "bash" }
    ]
  }
}
```

## Environment variables

Setup, teardown, scripts, and services all see:

- `$PASEO_SOURCE_CHECKOUT_PATH`, the original repo root
- `$PASEO_WORKTREE_PATH`, the worktree directory
- `$PASEO_BRANCH_NAME`, the worktree's branch
- `$PASEO_WORKTREE_PORT`, legacy per-worktree port (prefer `$PASEO_PORT` inside services)

Services additionally get:

- `$PASEO_PORT`, this service's assigned port
- `$PASEO_URL`, this service's proxy URL
- `$PASEO_SERVICE_<NAME>_PORT` / `_URL`, peer service ports and URLs
- `$HOST`, `127.0.0.1` for local-only daemons, `0.0.0.0` when the daemon binds all interfaces

## Manage the workspace

```bash
paseo workspace ls
paseo run --workspace <workspace-id> "implement auth"
paseo workspace rename <workspace-id> "Auth rework"
paseo workspace archive <workspace-id>
```

For the common case, `paseo run --new-workspace worktree --worktree-mode branch-off --new-branch feature/auth --base origin/main "implement auth"` creates both the workspace and its first agent.
