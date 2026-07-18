---
name: paseo
description: Paseo reference for managing workspaces, agents, schedules, and heartbeats.
---

Paseo is a daemon that supervises AI coding agents on your machine. Control it through tools or a CLI.

## Workspaces

**`create_workspace`** — create a workspace independently of any agent. Required: `isolation` (`local` or `worktree`). Worktree isolation supports `mode: "branch-off" | "checkout-branch" | "checkout-pr"`: use `branchName`/`baseBranch` for a new branch, `branch` for an existing branch, or `prNumber` plus optional `forge`/`projectPath` for a change request. `worktreeSlug` controls the managed path. Returns the workspace descriptor centered on `workspaceId`.

**`list_workspaces`** — list active workspaces.

**`archive_workspace`** — `{ workspaceId }`. Archives the workspace, its agents, and its terminals. Local directories remain; Paseo removes an owned worktree only after its final active workspace reference is archived.

Worktree creation and reference accounting are implementation details of `isolation: "worktree"`.

## Agents

**`create_agent`** — required: `title`, `provider` (`claude/opus`, `codex/gpt-5.4`, …), `initialPrompt`. Optional: `workspaceId`, `notifyOnFinish`, `settings`, `labels`. Returns `{ agentId, workspaceId, … }`.

Initial runtime settings live under `settings`: `modeId`, `thinkingOptionId`, and provider-specific `features`. For Codex fast mode, pass `settings: { features: { "fast_mode": true } }` when creating the agent.

Agent-scoped creation always creates your subagent. Omit `workspaceId` to use your current workspace; pass a workspace returned by `create_workspace` for isolated delegation. Placement never changes parentage.

Detach is an explicit user action in the subagents track, not an agent tool. A cross-workspace child remains your subagent even though it also appears as a normal tab in its workspace.

Agent-scoped `create_agent` defaults `notifyOnFinish` to true. Set it to `false` only for truly fire-and-forget agents.

**`send_agent_prompt`** — `{ agentId, prompt }`. Use for follow-ups to an existing agent. Agent-scoped prompt calls default to `background: true` and `notifyOnFinish: true`; top-level calls default to blocking with no callback. For a synchronous follow-up, pass `background: false` and use the returned result.

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

**`delete_heartbeat`** stops it. MCP intentionally exposes no heartbeat update tool; delete and recreate when its task or cadence changes.

Schedules have the full list/inspect/update/pause/resume/run-once/log/delete surface. Heartbeats deliberately do not.

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

For agent-scoped `create_agent` and background `send_agent_prompt`, leave `notifyOnFinish` omitted or set it to `true` unless the work is truly fire-and-forget. You will get notified when the target agent finishes, errors, or needs permission. Move on to other work. The notification arrives on its own.

Don't poll `list_agents` or `get_agent_status` to "check on" a running agent. The notification will tell you.

## CLI semantics

The CLI and tools use the same ownership semantics even where their syntax differs:

```bash
paseo workspace create --isolation worktree --mode branch-off --new-branch fix-x --base main
paseo workspace create --isolation worktree --mode checkout-branch --branch existing-work
paseo workspace create --isolation worktree --mode checkout-pr --pr-number 42
paseo run --provider codex/gpt-5.4 --mode full-access --workspace <workspace-id> "<prompt>"
paseo send <agent-id> "<follow-up>"
paseo ls
paseo schedule create --cron "*/15 * * * *" "ping main build"
paseo heartbeat create --cron "*/15 * * * *" "check the build"
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
