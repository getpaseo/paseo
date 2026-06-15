# Terminal Activity Indicators

Paseo surfaces terminal activity as a tab indicator (the same "running" dot used by agents).

## Current state

Terminal activity is source-agnostic plumbing. `TerminalActivityTracker` holds the current per-terminal state and emits transitions to the manager, worker protocol, websocket subscription, app buckets, dots, and notifications.

The tracker defaults to unknown (`null`). Activity production lives outside terminal stream parsing: agent hook commands report coarse activity to the daemon's local `/api/terminal-activity` endpoint.

## Architecture

```
TerminalSession
  ├── TerminalActivityTracker               one per session
  │     ├── set(state)                      records the latest state
  │     └── onChange(snapshot, previous)    fires only on resolved-state transitions
  │
  └── onActivityChange({ activity, previous })   subscribed in TerminalManager
        ├── emits terminalsChanged          workspace bucket + tab indicators
        └── subscribeTerminalActivity       per-transition stream for notification policy
```

`TerminalActivityTracker` is the single stateful object per session. It holds `{ state, changedAt }`, starts at unknown (`null`), and fires `onChange` only when the state actually changes.

### Transitions carry their own history

Each `onChange` delivers both the new snapshot and the `previous` one (`{ state, changedAt }`). The transition flows unchanged up through `TerminalSession.onActivityChange` (as `{ activity, previous }`), the worker protocol's `terminalActivityChange` event, and the manager-level `subscribeTerminalActivity(listener)` stream (`{ terminalId, name, cwd, activity, previous }`).

The daemon consumes these transitions, not snapshots. When a transition moves from `working` to `idle`, the tracker records finished attention, so the terminal shows the same green finished dot as an idle agent that needs review. The websocket layer also fires a "Terminal finished" attention notification. A terminal that exits while still working emits no turn-end notification.

Terminal workspace membership is path-prefix based: a terminal opened in a workspace subdirectory rolls up to the deepest active parent workspace for status buckets and notification routing.

## Hook reporting

Terminals receive four environment variables when the daemon creates the shell:

- `PASEO_TERMINAL_ID`
- `PASEO_ACTIVITY_TOKEN`
- `PASEO_TERMINAL_ACTIVITY_URL`
- `PASEO_HOOK_CLI` — absolute path to the current `paseo` CLI executable.

The generated shell command uses `PASEO_HOOK_CLI` to run the current CLI. `paseo hooks <agent> <event>` then reads the terminal id, token, and activity URL, asks the agent hook provider registry to resolve the event to a coarse activity state, and silently posts `{ terminalId, token, state }` to the activity URL. Missing env, unsupported agents/events, malformed hook input, and daemon/network failures are no-ops so agent hooks never break the user's terminal session.

Claude hook mapping:

- `UserPromptSubmit` → `running`
- `Stop`, `StopFailure`, `SessionEnd` → `idle`
- `Notification` with `reason` or `matcher` equal to `idle_prompt` → `needs-input`

Codex hook mapping:

- `UserPromptSubmit` → `running`
- `PreToolUse`, `PostToolUse` → `running`
- `PermissionRequest` → `needs-input`
- `Stop` → `idle`

OpenCode uses a server plugin instead of command hooks. The plugin listens to OpenCode bus events and emits these Paseo hook events:

- `session.status` with `busy` or `retry` → `running`
- `session.status` with `idle` → `idle`
- `permission.asked` → `needs-input`
- `permission.replied` → `running`

The daemon maps hook states onto terminal activity like an agent lifecycle plus unread attention: `running` → `state: working`, `idle` → `state: idle`, and `needs-input` → `state: idle` with `attentionReason: needs_input`. A `working` → `idle` transition records `state: idle` with `attentionReason: finished` until the user focuses that terminal; plain idle terminals still contribute no workspace status.

## Focus clearing

Client heartbeats include the focused terminal id. When a visible client focuses a terminal with an `attentionReason`, the daemon clears the attention and leaves the terminal idle. Plain idle terminal activity does not contribute to workspace status, so a workspace whose only attention source was that terminal rolls up from `needs_input` or `attention` back to `done`.

### Agent hook installation

Installing hooks edits the user's real agent config files, so it is opt-in. The daemon setting
`enableTerminalAgentHooks` (persisted under `daemon.enableTerminalAgentHooks`, default `false`)
gates installation. It is surfaced in the app under a host's **Terminals** settings as "Enable
terminal agent hooks" — "Get notifications and status from terminal agents. This installs hooks in
your agent config files." `applyTerminalAgentHookSetting` reconciles the installed hooks with the
setting: at startup it installs only when enabled; toggling the setting live installs on enable and
removes Paseo's marker-matched hooks on disable. `paseo hooks` keeps working regardless — the gate
only controls whether the daemon writes hooks into agent configs, not whether the CLI can post
activity when the env is present.

When enabled, Paseo installs provider hooks globally:

- Claude hooks are written to `~/.claude/settings.json` (or `CLAUDE_CONFIG_DIR/settings.json` when that override is set).
- Codex hooks are written to `~/.codex/hooks.json` (or `CODEX_HOME/hooks.json` when that override is set). Codex supports a native `commandWindows`, so each Paseo hook includes both POSIX and Windows commands. Non-managed Codex hooks are trust-gated by Codex; users may see Codex's hook review prompt before the hook runs.
- OpenCode gets a self-contained plugin at `$XDG_CONFIG_HOME/opencode/plugins/paseo-terminal-activity.js` (or `~/.config/opencode/plugins/paseo-terminal-activity.js` when XDG is unset; `OPENCODE_CONFIG_DIR` still wins when set).

Installation is marker-based/idempotent for config hooks and exact-file/idempotent for the OpenCode plugin. Paseo preserves user hooks, removes only its own marker-matched command hooks, and leaves hooks installed across daemon shutdown. Outside a Paseo terminal they are inert because the command or plugin is gated on `PASEO_TERMINAL_ID`.

Provider variation lives in `AGENT_HOOK_PROVIDERS`: provider id, installed events, config install metadata, and runtime event-to-activity resolution. The daemon calls `installRegisteredAgentHooks()` once; the CLI calls `resolveHookActivity(provider, event, input)`. Adding a provider should add one provider entry and register it in `AGENT_HOOK_PROVIDERS`, without editing the generic CLI command or daemon bootstrap.

The installed hook command keeps the config portable and resolves the CLI at runtime:

```sh
[ -n "$PASEO_TERMINAL_ID" ] && "${PASEO_HOOK_CLI:-paseo}" hooks claude <event>
```

Codex also receives the Windows equivalent:

```bat
if defined PASEO_TERMINAL_ID (if defined PASEO_HOOK_CLI ("%PASEO_HOOK_CLI%" hooks codex <event>) else (paseo hooks codex <event>))
```

Paseo injects `PASEO_HOOK_CLI` so Codex's hook shell cannot pick up a stale global `paseo` before the current one. The command still falls back to bare `paseo` if the env is missing, and it still no-ops outside Paseo terminals because the `PASEO_TERMINAL_ID` gate remains first. Paseo also prepends the CLI binary directory to each terminal `PATH` as a secondary fallback. All other behavior lives in `paseo hooks`: read the env, map the event, POST activity, and no-op/fail-open when anything is missing or unavailable.

If config installation fails, daemon startup and terminal spawn continue without terminal activity hooks.
