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

**`create_agent`** — required: `title`, `provider` (`claude/opus`, `codex/gpt-5.4`, …), `initialPrompt`. Common: `cwd` (often a `worktreePath`), `notifyOnFinish`, `settings`, `detached`. Returns `{ agentId, … }`.

Initial runtime settings live under `settings`: `modeId`, `thinkingOptionId`, and provider-specific `features`. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }` when creating the agent.

Compose: call `create_worktree` first, then `create_agent` with `cwd` set to the returned `worktreePath`.

### Agent relationships

Agents you create default to **your subagents**: omit `detached` or pass `detached: false`. Use this for advisors, committee members, planners, implementers, auditors, loop workers, and any agent whose lifetime belongs to your task. Subagents appear under you and are archived with you.

Pass `detached: true` only when the agent you create should stand on its own, not help you finish your task. Use this for handoffs and fire-and-forget delegations the user may continue after you are archived. Detached agents do not appear in your subagent track and are not archived with you.

For subagents, leave `notifyOnFinish` omitted or set it to `true`. You will get notified when the created agent finishes, errors, or needs permission. Set `notifyOnFinish: false` only when the created agent is truly fire-and-forget and you do not need to follow up.

**`send_agent_prompt`** — `{ agentId, prompt }`. Use for follow-ups to an existing agent.

**`update_agent`** — `{ agentId, name?, labels?, settings? }`. Use `settings` for runtime changes on an existing agent: `modeId`, `model`, `thinkingOptionId`, and provider-specific `features`. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }`.

**`list_agents`** — filter by `cwd`, `statuses`, `sinceHours`, `includeArchived`.

**`archive_agent`** — `{ agentId }`. Interrupts if running, removes from active list.

## Provider discovery

**`list_providers`** — compact provider availability and modes.

**`list_models`** — full model list for one provider. Use only when you need model IDs or thinking options; the list can be large.

**`inspect_provider`** — compact provider capability and feature inspection. Required: `provider`; pass `cwd` when you are not in an agent-scoped session. Optional: `settings` with draft `model`, `modeId`, `thinkingOptionId`, and `features`.

Only set feature IDs returned by `inspect_provider`. For Codex fast mode, look for `fast_mode` and pass `settings: { features: { "fast_mode": true } }` to `create_agent` or `update_agent`.

## Schedules and heartbeats

**`create_schedule`** — starts a new agent on a cron cadence. Required: `prompt`, `cron`, `provider`. Optional: `timezone`, `name`, `cwd`, `maxRuns`, `expiresIn`. Use when the recurring work should live in fresh agents.

**`create_heartbeat`** — sends you a prompt on a cron cadence. Required: `prompt`, `cron`. Optional: `timezone`, `name`, `maxRuns`, `expiresIn`. Use for reminders, PR/build babysitting, and status checks that should return to this conversation.

## Models

`claude/sonnet` (default), `claude/opus` (harder reasoning), `codex/gpt-5.4` (frontier coding), `claude/haiku` (tests only).

## Orchestration preferences

User-specific configuration at `~/.paseo/orchestration-preferences.json`. **Before any Paseo skill chooses a provider or creates an agent, it must read this file.** Reading means an actual file read, not relying on these examples or defaults. Never hardcode a provider string in another skill — resolve through this file.

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

For `create_agent`, leave `notifyOnFinish` omitted or set it to `true` unless the created agent is truly fire-and-forget. You will get notified when the created agent finishes, errors, or needs permission. **You must not call `wait_for_agent` on a notify-on-finish agent.** Move on to other work. The notification arrives on its own.

Don't poll `list_agents` or `get_agent_status` to "check on" a running agent. The notification will tell you.

## CLI parity

The `paseo` CLI is a thin wrapper over the same daemon. Same surface:

```bash
paseo run --provider codex/gpt-5.4 --mode full-access --worktree feat/x "<prompt>"
paseo send <agent-id> "<follow-up>"
paseo ls
paseo worktree ls
paseo schedule create --cron "*/15 * * * *" "ping main build"
```

Discover with `paseo --help` and `paseo <cmd> --help`.

**If `paseo` isn't on PATH but the desktop app is installed**, the bundled CLI is at:

- macOS: `/Applications/Paseo.app/Contents/Resources/bin/paseo`
- Linux: `<install-dir>/resources/bin/paseo`
- Windows: `C:\Program Files\Paseo\resources\bin\paseo.cmd`

The desktop app's first-run hook (`installCli`) symlinks this to `~/.local/bin/paseo` (macOS/Linux) or drops a `.cmd` trampoline (Windows) and adds `~/.local/bin` to PATH via shell rc files. If that didn't take, offer to symlink it — don't do it silently.

## Ops and debugging

Daemon-client architecture: the daemon owns agent lifecycle, state, and the WebSocket API. Tools, CLI, mobile, and desktop apps are all clients.

|                | Default                                                         |
| -------------- | --------------------------------------------------------------- |
| Listen address | `127.0.0.1:6767` (override `PASEO_LISTEN`)                      |
| Home           | `~/.paseo` (override `PASEO_HOME`)                              |
| Daemon log     | `$PASEO_HOME/daemon.log`                                        |
| Agent state    | `$PASEO_HOME/agents/<id>.json`                                  |
| Worktrees      | `$PASEO_HOME/worktrees/` (or `worktrees.root` in `config.json`) |
| PID file       | `$PASEO_HOME/paseo.pid`                                         |
| Health         | `GET http://127.0.0.1:6767/api/health`                          |

Debug order:

1. `tail -n 200 ~/.paseo/daemon.log`.
2. `paseo daemon status` for liveness.
3. `curl -s localhost:6767/api/health` if the CLI itself is suspect.

**Never restart the daemon without explicit user approval** — it kills every running agent, including, often, the one asking.
