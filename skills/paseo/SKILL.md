---
name: paseo
description: Paseo reference for managing agents and worktrees. Load whenever you need to create agents, send them prompts, or manage worktrees.
---

Paseo is a daemon that supervises AI coding agents on your machine. Control it through tools or a CLI.

## Worktrees

**`create_worktree`** — three modes:

- From a PR: `{ githubPrNumber: 503 }`.
- Branch off a base: `{ action: "branch-off", branchName: "fix/foo", baseBranch: "main" }`.
- Checkout an existing ref: `{ action: "checkout", refName: "feat/bar" }`.

Returns `{ branchName, worktreePath }`. Pass `cwd` to target a specific repo.

**`list_worktrees`** — current repo (or pass `cwd`).
**`archive_worktree`** — `{ worktreePath }` or `{ worktreeSlug }`. Removes worktree and branch.

## Agents

**`create_agent`** — required: `title`, `provider` (`claude/opus`, `codex/gpt-5.4`, …), `initialPrompt`. Common: `cwd` (often a `worktreePath`), `background` (default `false` — blocks until completion or permission), `notifyOnFinish`. Returns `{ agentId, … }`.

Compose: call `create_worktree` first, then `create_agent` with `cwd` set to the returned `worktreePath`.

**`send_agent_prompt`** — `{ agentId, prompt }`. Blocks by default; pass `background: true` to fire-and-forget.

**`list_agents`** — filter by `cwd`, `statuses`, `sinceHours`, `includeArchived`.

**`archive_agent`** — `{ agentId }`. Interrupts if running, removes from active list.

## Heartbeats

**`create_schedule`** — required: `prompt`. Pick one of `cron` or `every` (`"5m"`, `"1h"`). Optional: `name`, `target` (`self` | `new-agent`), `provider`, `maxRuns`, `expiresIn`. Use for periodic checks on long-running work or recurring maintenance.

## Models

`claude/sonnet` (default), `claude/opus` (harder reasoning), `codex/gpt-5.4` (frontier coding), `claude/haiku` (tests only).

## Orchestration preferences

User-specific configuration at `~/.paseo/orchestration-preferences.json`. **Any paseo skill that picks an agent reads this file.** Never hardcode a provider string in another skill — resolve through this file.

Two parts:

- `providers` — map of role categories to provider strings. Pass straight to `create_agent`'s `provider` field.
- `preferences` — freeform string array. Read on startup; weave into agent prompts contextually.

Categories: `impl`, `ui`, `research`, `planning`, `audit`. Skills pick the category that matches the role they're launching.

```json
{
  "providers": {
    "impl": "codex/gpt-5.4",
    "ui": "claude/opus",
    "research": "codex/gpt-5.4",
    "planning": "codex/gpt-5.4",
    "audit": "codex/gpt-5.4"
  },
  "preferences": [
    "Claude Opus is the right choice for anything artistic or human-skill-oriented: copywriting, naming, UX copy, visual design, styling. Codex is the workhorse for mechanical work."
  ]
}
```

If the file is missing, use sensible defaults and tell the user once.

## Waiting

Agents take time — 10–30+ minutes is routine. Favor asynchronous workflows.

For every `create_agent` or `send_agent_prompt`, pass `background: true` and `notifyOnFinish: true`. Paseo delivers a notification to your conversation when the agent finishes, errors, or needs permission. **You must not call `wait_for_agent` on a notify-on-finish agent.** Move on to other work. The notification arrives on its own.

Don't poll `list_agents` or `get_agent_status` to "check on" a running agent. The notification will tell you.

## CLI parity

The `paseo` CLI is a thin wrapper over the same daemon. Same surface:

```bash
paseo run --provider codex/gpt-5.4 --mode full-access --worktree feat/x "<prompt>"
paseo send <agent-id> "<follow-up>"
paseo ls
paseo worktree ls
paseo schedule create --every 5m "ping main build"
```

Discover with `paseo --help` and `paseo <cmd> --help`.

**If `paseo` isn't on PATH but the desktop app is installed**, the bundled CLI is at:

- macOS: `/Applications/Paseo.app/Contents/Resources/bin/paseo`
- Linux: `<install-dir>/resources/bin/paseo`
- Windows: `C:\Program Files\Paseo\resources\bin\paseo.cmd`

The desktop app's first-run hook (`installCli`) symlinks this to `~/.local/bin/paseo` (macOS/Linux) or drops a `.cmd` trampoline (Windows) and adds `~/.local/bin` to PATH via shell rc files. If that didn't take, offer to symlink it — don't do it silently.

## Ops and debugging

Daemon-client architecture: the daemon owns agent lifecycle, state, and the WebSocket API. Tools, CLI, mobile, and desktop apps are all clients.

|                | Default                                    |
| -------------- | ------------------------------------------ |
| Listen address | `127.0.0.1:6767` (override `PASEO_LISTEN`) |
| Home           | `~/.paseo` (override `PASEO_HOME`)         |
| Daemon log     | `$PASEO_HOME/daemon.log`                   |
| Agent state    | `$PASEO_HOME/agents/<id>.json`             |
| Worktrees      | `$PASEO_HOME/worktrees/`                   |
| PID file       | `$PASEO_HOME/paseo.pid`                    |
| Health         | `GET http://127.0.0.1:6767/api/health`     |

Debug order:

1. `tail -n 200 ~/.paseo/daemon.log`.
2. `paseo daemon status` for liveness.
3. `curl -s localhost:6767/api/health` if the CLI itself is suspect.

**Never restart the daemon without explicit user approval** — it kills every running agent, including, often, the one asking.
