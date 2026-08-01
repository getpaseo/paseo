# Background Tasks Track Design

**Date:** 2026-08-01  
**Status:** Approved for implementation planning  
**Scope:** Claude Code long-running shell background processes in the agent pane

## Problem

When Claude Code runs long-lived shell work in the background (for example `npm run dev` via Bash `run_in_background`), the user has no agent-pane surface that answers:

- What background commands are still running for this agent?
- Can I open details and see output?
- Can I stop a process without hunting through the timeline?

Today Paseo only maps Claude **completion** `task_notification` events into synthetic timeline tool calls. Live membership signals (`background_tasks_changed`, `task_started`, `task_progress`, `task_updated`) are not surfaced as a list. Provider subagents already have a collapsible track above the composer; background shell tasks need the same kind of visibility, stacked under Subagents.

## Goals

1. Show live long-running **shell** background tasks for the current agent.
2. Match Subagents track chrome: collapsible, hide when empty, stacked under Subagents.
3. Open a workspace tab on row tap with details and focused live logs.
4. Allow **Stop** from the track as an icon-only row action.
5. Stay honest about Claude capabilities: no fake PTY; poll/tail only when the user is actually viewing the task tab.

## Non-goals (v1)

- Other providers (Codex, OMP, OpenCode, Pi, Copilot).
- Non-shell Claude background work (subagents, monitors, workflows) — subagents keep their own track.
- Always-on log polling while the tab is hidden or unfocused.
- Stop control inside the detail tab.
- Pause/resume, archive, or inventing process controls Claude does not expose.
- Turning background tasks into full Paseo Terminal (PTY) sessions.
- Creating background tasks from the track (list + control existing work only).

## Glossary alignment

- **Background Tasks** — UI label for this track and product surface.
- Not **Schedule** / **Heartbeat** (Paseo cron automation).
- Not **Subagent** (related agent sessions; existing track stays separate).
- Not internal file/git **watchers** (infra, not user-facing jobs).

Add **Background Tasks** to `docs/glossary.md` during implementation as a **Composer track** sibling of Subagents track.

## Product decisions (locked)

| Decision     | Choice                                                        |
| ------------ | ------------------------------------------------------------- |
| What to list | Only long-running shell commands                              |
| Empty state  | Hide track completely                                         |
| Track name   | Background Tasks                                              |
| Tap row      | Open a new workspace tab (like provider subagents)            |
| Stop         | Track row only, icon-only (like subagent archive)             |
| Logs         | Auto-refresh only while the user is actually viewing that tab |
| Provider     | Claude Code only in v1                                        |

## UX

### Placement

In `agent-panel` input area, order is:

1. Subagents track (existing)
2. **Background Tasks track** (new)
3. Composer

Reuse Subagents visual language: outer max-width surface, top rounded corners, chevron header, muted label, expandable row list with max height scroll.

### Header

- Collapsed/expanded via header press.
- Label format: `Background Tasks` or `Background Tasks (N)` when N > 0 (implementation may mirror Subagents’ `formatHeaderLabel` pattern).
- No header bulk actions in v1.

### Rows

Each live shell task row:

- Primary label: command when available, else Claude description.
- Optional muted status (running / stopped / failed when known).
- Primary press: open detail tab.
- Hover (web) / always-visible (native/compact): icon-only **Stop** action with tooltip/a11y label “Stop”.

Closing the detail tab does not stop the process.

### Detail tab

New workspace tab kind (parallel to `provider_subagent`):

- Title from command or description.
- Header: command, status, short description.
- Live log area when output is available.
- Explicit empty state when no log path/content exists.
- No Stop button in the tab (control stays on the track).

## Data model

### Source of truth (daemon / Claude)

Claude Agent SDK emits:

- `system` / `background_tasks_changed` — **level** signal; replace local set with payload `tasks: { task_id, task_type, description }[]`.
- `system` / `task_started`, `task_progress`, `task_updated`, `task_notification` — edge/progress/completion enrichment.
- Bash tool results may include `backgroundTaskId` and later `output_file` on notifications.
- Session API: `stopTask(taskId)` stops a running task; completion arrives as `task_notification` with status `stopped`.

On CLI/process restart, live membership resets to empty until the next membership change (SDK semantics).

### Filtering

Include only shell/long-running command tasks. Treat a task as shell when its Claude type is `shell` (friendly label or raw discriminant). Exclude `subagent`, `monitor`, `workflow`, and any other non-shell type from this track.

### Per-task fields (protocol shape, conceptual)

```ts
interface BackgroundTaskDescriptor {
  taskId: string;
  parentAgentId: string; // Paseo agent id owning the Claude session
  type: string; // Claude task type; shell-only after filter
  description: string;
  command?: string | null;
  status: "running" | "completed" | "failed" | "stopped" | "unknown";
  outputFile?: string | null;
  lastSummary?: string | null;
  updatedAt: string; // ISO
}
```

Exact wire schema lives in protocol with dotted RPC namespacing and optional fields for backward compatibility.

### App store

Client keeps a per-`(serverId, parentAgentId)` list of live background tasks, updated by push and/or list RPC (same spirit as provider subagents store). Track UI selects rows for the open agent only.

## Protocol / daemon

### Capability

Advertise `server_info.features.backgroundTasks` with a `// COMPAT(backgroundTasks): added in <version>, drop the gate when floor >= <version>` comment. Client shows the track only when the host supports it **and** the open agent is Claude (or otherwise supplies live shell background tasks).

### RPCs (directional, dotted)

Locked names:

- `agent.background_tasks.list.request` / `agent.background_tasks.list.response` — snapshot for an agent.
- `agent.background_tasks.update` — push full live set for an agent (replace semantics on membership change; may also carry field enrichment).
- `agent.background_tasks.stop.request` / `agent.background_tasks.stop.response` — stop by `taskId` + parent agent id.
- `agent.background_tasks.output.get.request` / `agent.background_tasks.output.get.response` — fetch/tail a log chunk (cursor + max bytes).
- `agent.background_tasks.output.subscribe.request` / `agent.background_tasks.output.subscribe.response` and `agent.background_tasks.output.update` — focus-gated log subscription; daemon only tails while subscribed; client unsubscribes on blur/close.

All new fields optional; old clients ignore unknown messages they do not subscribe to.

### Claude adapter responsibilities

1. Subscribe to SDK system messages for background task lifecycle.
2. Maintain in-memory live set per Claude session/agent; apply replace on `background_tasks_changed`.
3. Enrich with command from Bash tool_result `backgroundTaskId` when correlatable.
4. Enrich with `output_file` / summary from `task_notification` / progress messages.
5. Filter to shell-only for the public list.
6. Implement `stopTask` via SDK `stopTask(taskId)`.
7. Implement output fetch by reading/tailing `outputFile` when present, or best-effort TaskOutput-style path if available without inventing a PTY.
8. Cap log payload size (tail of file); never unbounded dumps over WS.

### Live log focus gate

- Polling/tailing runs only while at least one connected client reports the corresponding Background Task tab as **focused/visible**.
- Leaving the tab, unfocusing the pane, or closing the tab cancels that task’s log subscription.
- The track list itself never triggers log polling.
- On task terminal status, one final refresh is allowed, then polling stops.

## UI architecture

### Track

New module under something like `packages/app/src/background-tasks/` (or adjacent to `subagents/`):

- `track.tsx` — chrome cloned from Subagents track patterns (styles, hover actions).
- `select.ts` / store hooks — rows for parent agent.
- `use-stop-background-task.ts` — stop mutation + pending state.

Mount in `packages/app/src/panels/agent-panel.tsx` immediately below `SubagentsTrack`.

### Tab / panel

- Extend workspace tab target model with `{ kind: "background_task"; parentAgentId: string; taskId: string }`.
- Deterministic tab id in `workspace-tabs/identity`.
- Panel registration parallel to `provider-subagent-panel.tsx`.
- Presentation: terminal-ish monospace log view, auto-scroll to bottom when user is at bottom; respect focus gate for refresh.

### i18n

Keys for track header, stop tooltip/a11y, empty log state, stop failure toast. Follow existing i18n patterns for all locales in use.

## Error handling

| Case                                      | Behavior                                                        |
| ----------------------------------------- | --------------------------------------------------------------- |
| Stop fails                                | Toast/error; task remains until Claude reports removal          |
| No output file                            | Detail tab shows status + description + “No live log available” |
| Agent disconnect / Claude process restart | Live list clears; open tabs show disconnected/stale             |
| Host without feature                      | Track never mounts                                              |
| Non-Claude agent                          | Track empty / not applicable                                    |

## Testing

### Unit (app)

- Shell-only filter; non-shell excluded.
- Track returns `null` when row count is 0.
- Stop action is icon-only and only on track rows.
- Focus gate: no output fetch while tab unfocused; fetch while focused.

### Unit / integration (server)

- Map `background_tasks_changed` replace semantics.
- `task_notification` / progress enrich status and output path.
- `stopTask` wires to SDK and surfaces errors.
- Log tail caps size; missing file returns structured empty/error.

### UI / e2e (targeted, not full suite)

- Open tab from row.
- Stop settles/removes row when stopped notification arrives.
- Prefer fake Claude harness over real API unless an existing real e2e pattern is cheap to extend.

## Implementation phases (for plan skill)

1. Protocol + daemon live set + list/update + stop (no UI).
2. App store + Background Tasks track + stop icon.
3. Workspace tab + static details + output get.
4. Focus-gated live log subscription/polling.
5. Glossary, i18n, tests, feature flag docs.

## Alternatives considered

| Approach                                  | Why not for v1                                                |
| ----------------------------------------- | ------------------------------------------------------------- |
| Infer only from timeline shell tool calls | Stale membership; weak correlation; no reliable live set      |
| Full PTY per background process           | Claude does not expose a free PTY stream; heavy bandwidth     |
| Include all Claude background task types  | Overlaps Subagents; user asked for long-running commands only |
| Paseo schedules/heartbeats track          | Different product; user clarified Claude background processes |

## Success criteria

- User can see live shell background tasks for a Claude agent without leaving the agent pane.
- User can stop a running background command from the track with one icon action.
- User can open a tab and watch logs update **only while looking at that tab**.
- Empty agents stay clean (no empty chrome).
- Old clients/daemons remain protocol-compatible.
