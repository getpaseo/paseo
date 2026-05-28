---
title: Git worktrees
description: Run agents in isolated git worktrees with setup hooks, scripts, and long-running services.
nav: Git worktrees
order: 7
---

# Git worktrees

Each agent runs in its own git worktree, a separate directory on a separate branch, so parallel agents never step on each other. You configure setup, scripts, and long-running services through a `paseo.json` file at your repo root.

## Layout and workflow

Worktrees live under `$PASEO_HOME/worktrees/`, grouped by a hash of the source checkout path. Each worktree gets a random slug; the branch name is chosen when you first launch an agent.

```
~/.paseo/worktrees/
└── 1vnnm9k3/               # hash of source checkout path
    ├── tidy-fox/           # worktree slug (branch set on first agent)
    └── bold-owl/
```

1. Create a worktree, Paseo runs your setup hooks
2. Launch an agent, a branch is created or assigned
3. Review the diff against the base branch
4. Merge or archive, archive runs teardown and removes the directory

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

### Reverse proxy

Every service is reachable through the daemon at a deterministic hostname:

```
http://<script>.<branch>.<project>.localhost:<daemon-port>

# on the default branch, the branch label is dropped:
http://<script>.<project>.localhost:<daemon-port>
```

`*.localhost` resolves to `127.0.0.1` on modern systems, so these URLs work out of the box. The proxy supports WebSocket upgrades.

### Service-to-service

Services launched from the same workspace see each other's ports and proxy URLs. Given `web` and `api` above, each process gets:

```
PASEO_PORT=3000                         # this service's port
PASEO_URL=http://web.my-app.localhost:6767  # this service's proxy URL
PASEO_SERVICE_API_PORT=51732
PASEO_SERVICE_API_URL=http://api.my-app.localhost:6767
PASEO_SERVICE_WEB_PORT=3000
PASEO_SERVICE_WEB_URL=http://web.my-app.localhost:6767
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

## CLI

```bash
paseo run --worktree feature-auth --base main "implement auth"
paseo worktree ls
paseo worktree archive feature-auth
```
