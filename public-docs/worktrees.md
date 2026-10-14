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

### Custom placement with a script

If you want full control over where each worktree goes, set `worktrees.pathScript` in `config.json` to an executable you control. This is a daemon-level setting, not a `paseo.json` setting. Restart the daemon after changing it.

```json
{
  "worktrees": {
    "pathScript": "/home/you/bin/place-worktree"
  }
}
```

Every time Paseo creates a worktree, it runs your executable in the source checkout with no shell and waits up to 30 seconds for it to print exactly one line: the absolute path for the new worktree. Your script must be pure. It decides the path and prints it; it must not create the directory or the worktree itself. Paseo runs `git worktree add`, setup, teardown, archive, and delete as usual, and it records the actual path, so changing or removing the script later never moves existing worktrees.

The path must be absolute, must not already exist, and must not be the source checkout, inside a `.git` directory, an ancestor of the source checkout, your home directory, or the filesystem root. If the script exits non-zero, times out, or prints anything other than one absolute path, creation fails and the error includes the script's stderr. There is no fallback to the default layout.

Paseo passes the same context as positional arguments and as environment variables. Absent values (no remote, no base ref) are empty strings.

| #   | Environment variable  | Value                                                                               |
| --- | --------------------- | ----------------------------------------------------------------------------------- |
| $1  | `PASEO_REPO_PATH`     | Source checkout path                                                                |
| $2  | `PASEO_REPO`          | Source checkout directory name                                                      |
| $3  | `PASEO_OWNER`         | Remote owner path (`origin`, else first remote)                                     |
| $4  | `PASEO_REMOTE_REPO`   | Remote repository name                                                              |
| $5  | `PASEO_BRANCH_NAME`   | Branch being created or checked out                                                 |
| $6  | `PASEO_WORKTREE_SLUG` | Worktree slug                                                                       |
| $7  | `PASEO_REPO_HASH`     | 8-character hash of the source checkout path                                        |
| $8  | `PASEO_WORKTREE_MODE` | `branch-off`, `checkout-branch`, `checkout-change-request`, or `checkout-github-pr` |
| $9  | `PASEO_BASE_REF`      | Base ref for `branch-off`; empty otherwise                                          |
| $10 | `PASEO_HOME`          | Paseo home directory                                                                |

For example, this script reproduces a sibling layout next to each checkout:

```sh
#!/bin/sh
printf '%s.worktrees/%s\n' "$1" "$6"
```

Send any logging to stderr. Anything extra on stdout breaks the one-line contract.

To see what Paseo would pass for a given repo and branch without running your script, use `paseo worktree path-script-preview --path ~/dev/my-app --branch feature/example`. It reads `config.json` on disk and prints the script, working directory, arguments, and environment; it never executes the script. The preview shows the inputs as supplied: live creation can adjust them (the branch is uniquified when it is already checked out in another worktree, and `branch-off` passes the resolved base ref, so pass `--base-ref` yourself to match a real creation).

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
