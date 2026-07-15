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

Worktrees live under `$PASEO_HOME/worktrees/` by default, grouped by a hash of the source checkout path. You can change the base directory with `worktrees.root` in `config.json`. Each worktree gets a random slug; the branch name is chosen when you first launch an agent.

```
~/.paseo/worktrees/
└── 1vnnm9k3/               # hash of source checkout path
    ├── tidy-fox/           # worktree slug (branch set on first agent)
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
  "agentEnv": "direnv exec . env -0",
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

## Agent environment

`agentEnv` is a top-level `paseo.json` key: the environment for the agent CLI **and the MCP servers it spawns**, resolved before the CLI starts. It's the committed way to give an agent the environment you already manage with [direnv](https://direnv.net), [mise](https://mise.jdx.dev), or a script — and the only way to set variables the CLI reads at startup, since the CLI is launched directly rather than through your shell.

It sits at the top level rather than under `worktree` because it's an agent-launch concern, not part of the worktree lifecycle.

Use it for:

- **Variables the agent CLI itself reads at startup** — for example a per-project `CLAUDE_CONFIG_DIR` to pick which Claude account a project uses.
- **`PATH` and project tooling** — a project's `bin/`, `node_modules/.bin`, or mise/asdf shims that its docs assume are on `PATH`.
- **Secrets for MCP servers** — API keys the MCP servers read from the environment, which otherwise never reach them. No more wrapping each `.mcp.json` server to load them.

### Static variables

An object sets variables directly. No shell, no subprocess.

```json
{
  "agentEnv": {
    "CLAUDE_CONFIG_DIR": ".claude-work",
    "NODE_OPTIONS": "--max-old-space-size=8192"
  }
}
```

### A command that prints the environment

A string is a command that **prints the environment to stdout**. Paseo runs it and applies what it printed. Three output encodings are accepted, detected automatically:

| Encoding                      | Example command        | Multi-line values |
| ----------------------------- | ---------------------- | ----------------- |
| JSON object                   | `mise env --json`      | yes               |
| NUL-delimited `KEY=VALUE`     | `direnv exec . env -0` | yes               |
| Newline-delimited `KEY=VALUE` | `echo FOO=bar`         | **no**            |

**direnv** — keep your committed `.envrc` (and a gitignored `.envrc.local` for per-dev secrets). Run `direnv allow` once in the checkout.

```json
{
  "agentEnv": "direnv exec . env -0"
}
```

Use `env -0`, not plain `env`: NUL-delimited output is what lets a multi-line secret (a PEM key, a service-account JSON blob) survive. Plain `env` truncates it at the first newline. `direnv export json` is not a substitute — it prints nothing once the environment is already loaded.

**mise** — `mise env --json` prints the `[env]` block from `mise.toml` plus `PATH`, as JSON, so multi-line values are safe.

```json
{
  "agentEnv": "mise env --json"
}
```

### Both together

An array is an ordered list of layers, merged left to right — later layers win, so precedence is visible in the file. Each command runs with the earlier layers already applied.

```json
{
  "agentEnv": [{ "CLAUDE_CONFIG_DIR": ".claude-work" }, "direnv exec . env -0"]
}
```

### How it works and what to know

- **Commands run in the source checkout.** Unlike `worktree.setup`, which runs later in the background, `agentEnv` resolves synchronously before the agent, with its working directory set to `$PASEO_SOURCE_CHECKOUT_PATH` — the original checkout, where your committed `.envrc`/`mise.toml` and your gitignored secrets live. So it works even on a brand-new worktree whose setup hasn't finished. `$PASEO_WORKTREE_PATH`, `$PASEO_BRANCH_NAME`, and `$PASEO_SOURCE_CHECKOUT_PATH` are all available, so a command can target the worktree explicitly (`direnv exec "$PASEO_WORKTREE_PATH" env -0`) if you prefer.
- **It feeds the agent and its MCP servers.** MCP servers the agent launches inherit the environment. You no longer need to wrap each `.mcp.json` server to load secrets.
- **It's a snapshot.** Commands run once per launch; rotated secrets or `.envrc` changes apply on the next launch.
- **Print only the environment to stdout.** Log to stderr instead — direnv and mise already do. A command that prints anything else fails the launch rather than importing half an environment.
- **It fails fast.** A non-zero exit, a timeout, or unparseable output aborts the launch rather than starting an agent with a half-resolved environment. Keep secrets out of your tool's stderr — error output may be surfaced.
- **Commands contribute only what they changed.** A variable a command doesn't touch is unaffected, so a per-user `runtimeSettings.env` override of an unrelated variable still applies.
- **Variables can be added or overridden, not removed.**
- **A malformed `agentEnv` fails the launch.** It is not partially applied — a dropped layer would mean an agent starting without a secret it needs, which surfaces later as a confusing auth error inside an MCP server.
- **It applies to agents, not to Paseo itself.** `agentEnv` feeds the agent CLI and the MCP servers it spawns. Paseo's own commands — the `gh` calls behind pull-request status, `git` — still run with the daemon's environment, so a per-project `GH_CONFIG_DIR` or `GH_TOKEN` here will not change which account Paseo uses.
- **`worktree.setup` cannot hand variables to the agent.** The agent starts before setup runs, so a database URL or credential that setup generates is not in the agent's environment.
- **It cannot make the agent CLI itself discoverable.** Paseo checks that the provider (Claude, Codex, ...) is installed before resolving `agentEnv`, so a CLI that only exists on a `PATH` your command produces will not be found. Install the agent CLI normally; use `agentEnv` for the tools the agent _runs_.
- **Windows:** commands run under PowerShell, so use PowerShell syntax (`& "C:\path\tool.exe"` to invoke a quoted path). mise works natively; direnv evaluates `.envrc` with bash, so it needs Git Bash or WSL.

> A command in `agentEnv` runs on every agent launch, the same trust model as `worktree.setup`/`teardown`. Only open repos you trust. Static variables run nothing.

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

Setup, teardown, `agentEnv`, terminals, scripts, services, **and the agent itself** all see:

- `$PASEO_SOURCE_CHECKOUT_PATH`, the original repo root
- `$PASEO_WORKTREE_PATH`, the worktree directory
- `$PASEO_BRANCH_NAME`, the worktree's branch
- `$PASEO_WORKTREE_PORT`, legacy per-worktree port (prefer `$PASEO_PORT` inside services)

So an agent can find the checkout it branched from — to read a gitignored file, or to compare against the original — without being told where it is. Agents also get `$PASEO_AGENT_ID`.

`agentEnv` runs before the worktree's port is assigned, so `$PASEO_WORKTREE_PORT` is only present for `agentEnv` and the agent if the worktree already has one.

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
