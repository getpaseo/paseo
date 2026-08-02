# Agent Pane Visibility Design

**Date:** 2026-08-02  
**Status:** Approved for implementation planning  
**Scope:** Full agent-pane visibility package — expanded Background Tasks, Heartbeats track (Paseo + provider session schedules), Loops track (Paseo only)

## Problem

After Background Tasks v0.2.916 (Claude shell-only), the agent pane still cannot answer:

1. **What will re-prompt this chat?** — Paseo Heartbeats live only on the global Schedules screen; Claude Code session crons (`CronCreate`) and `/loop` (fixed + dynamic `ScheduleWakeup`) are invisible.
2. **Is this agent inside a Paseo Loop?** — Worker/verifier roles are daemon-only / CLI-shaped.
3. **What else is Claude still running?** — Monitors, workflows, and other non-shell live tasks are filtered out of Background Tasks.

Users who prefer Claude’s built-in `/loop` and session crons get worse UX in Paseo than in the Claude TUI. Paseo Heartbeats and Paseo Loops are real product surfaces that should appear **where the agent is**, with the same track grammar as Subagents.

## Goals

1. Answer, from one agent pane: queue, related agents, **scheduled re-prompts for this chat**, **Paseo loops this agent is in**, **Claude (and future provider) live work**.
2. Stack (top → bottom, above composer):

   ```
   Queue → Subagents → Heartbeats → Loops → Background Tasks → Composer
   ```

3. **Hide every track when empty** (no empty “add” chrome on tracks).
4. Reuse **Subagents grammar** for mixed ownership: `kind: "paseo" | "provider"` + `provider` on provider rows — **not** owner-badge chrome, **not** hardcoded `kind: "claude"`.
5. Actions match ownership: only show controls Paseo can honor for that row kind.
6. Keep Claude vs Paseo jobs distinct: Claude `/loop` is session re-prompt (Heartbeats family); Paseo Loop is multi-agent verify-until-done (Loops track only).

## Non-goals

- New-agent **Schedules** on the agent pane (global Schedules screen only).
- Subagent-typed provider tasks in Background Tasks (Subagents track owns those).
- Codex **Goal**, cloud Routines, Desktop scheduled tasks, workspace terminals/scripts.
- Client liveness / WebSocket heartbeats.
- Permanent empty tracks or track-level “Create heartbeat”.
- Merging Heartbeats + Loops under one “Automation” label.
- Treating Claude `/loop` as Paseo Loop (wrong shape).
- Hardcoding product kinds or track names to Claude alone (Claude is first adapter).

## Glossary

| Term                 | Meaning                                                                                                                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Composer track**   | Contextual lane above the composer. This package adds **Heartbeats track** and **Loops track**; expands **Background Tasks track**.                                                                              |
| **Heartbeat**        | Re-prompt **this** agent/conversation later. Includes **Paseo** agent-target schedules and **provider** session schedules (Claude: CronCreate / fixed `/loop` / dynamic `/loop`). UI track name: **Heartbeats**. |
| **Loop** (Paseo)     | Daemon-orchestrated worker → verifier iterations until pass/stop. UI track name: **Loops**. Not Claude `/loop`.                                                                                                  |
| **Background Tasks** | Provider live long-running work that is **not** a subagent (shell, monitor, workflow, other).                                                                                                                    |
| **Schedule**         | Paseo cron that creates **new** agents — not on the agent pane.                                                                                                                                                  |

Update `docs/glossary.md` during implementation: extend Heartbeat to cover provider session schedules; clarify Claude `/loop` maps to Heartbeats (provider), not Loops; update Background Tasks beyond shell-only.

## Product decisions (locked)

| Decision                                 | Choice                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Claude non-shell live work               | Same **Background Tasks** track + type badges                                         |
| Background types                         | Shell + monitor + workflow + **generic other**; exclude subagent-family               |
| Type UI                                  | Short badge (Shell / Monitor / Workflow / Other) + description                        |
| Paseo Heartbeats vs Claude session crons | **One Heartbeats track**, Subagents grammar (`paseo` \| `provider`)                   |
| Kind naming                              | `provider` + `provider: AgentProvider` — extensible; no `kind: "claude"`              |
| Heartbeat actions (paseo)                | Open edit sheet + pause/resume + delete                                               |
| Heartbeat actions (provider)             | Open detail; delete/cancel when adapter supports CronDelete-equivalent; no fake pause |
| Paseo Loops on pane                      | Yes — separate **Loops** track                                                        |
| Loop membership                          | This agent is `activeWorkerAgentId` **or** `activeVerifierAgentId`                    |
| Loop actions                             | Open inspect + Stop                                                                   |
| Claude `/loop` placement                 | Provider Heartbeat rows (not Loops track)                                             |
| Track order                              | Queue → Subagents → Heartbeats → Loops → Background Tasks                             |
| Empty                                    | Hide when empty                                                                       |
| First ship slice                         | Full package (all three) in one design; plan may phase impl                           |

## Similarity map (why grouping is this way)

| Job                           | Surfaces                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Re-prompt this chat           | Paseo Heartbeat · Claude CronCreate · Claude fixed `/loop` · Claude dynamic `/loop` + ScheduleWakeup → **Heartbeats track** |
| Multi-agent verify-until-done | Paseo Loop only → **Loops track**                                                                                           |
| Live process / event stream   | Shell · Monitor · Workflow · other non-subagent → **Background Tasks**                                                      |
| Related agent sessions        | Paseo + provider subagents → **Subagents** (unchanged)                                                                      |

Claude `/loop` is **not** Paseo Loop: no worker/verifier agents, session-scoped, Esc/CronDelete/ScheduleWakeup stop semantics. See [Claude scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks).

## UX

### Shared track chrome

Match Subagents / Background Tasks: collapsible header with count, max-height scroll, hide when `rows.length === 0`, hover/native-visible row actions.

### Heartbeats track

**Membership**

- **Paseo:** schedules with `target.type === "agent"`, `target.agentId === this agent`, status `active` or `paused` (not `completed`).
- **Provider:** session-scoped scheduled tasks for this agent’s provider runtime (Claude v1: CronCreate list + `/loop` fixed/dynamic entries).

**Row model (conceptual)**

```ts
type HeartbeatRow =
  | {
      kind: "paseo";
      id: string; // schedule id
      name: string | null;
      prompt: string;
      status: "active" | "paused";
      cadenceLabel: string;
      nextRunAt: string | null;
    }
  | {
      kind: "provider";
      id: string; // provider-native task id
      parentAgentId: string;
      provider: AgentProvider;
      prompt: string;
      mode: "recurring" | "one_shot" | "dynamic";
      scheduleLabel: string; // cron humanized, "every 5m", "self-paced"
      nextHint: string | null; // next fire / next delay reason when known
    };
```

**Presentation**

- Header: `Heartbeats` / `Heartbeats (N)` — no “Paseo vs Claude” badge string.
- Leading icon: schedule/calendar for paseo; `getProviderIcon(row.provider)` for provider (same as Subagents).
- Primary: name or truncated prompt.
- Secondary: cadence + next run / Paused (paseo); scheduleLabel + nextHint (provider).

**Open**

- Paseo → existing Edit heartbeat sheet (`schedule-form-sheet` agent target).
- Provider → detail sheet: prompt, mode, schedule, id; no Paseo lifecycle controls.

**Row actions**

- Paseo: Pause or Resume (by status) + Delete (confirm).
- Provider: Delete/Cancel only if adapter can cancel; otherwise open-only. Never show Pause on provider rows unless a real API exists.

**Create:** not on track (MCP / natural language / global UI).

### Loops track (Paseo only)

**Membership:** loop `status === "running"` and (`activeWorkerAgentId === this` OR `activeVerifierAgentId === this`).

**Row**

- Primary: loop name or truncated prompt / id.
- Secondary: role chip **Worker** or **Verifier** + active iteration when known.
- Tap → workspace tab kind `loop` (inspect + logs).
- Stop → icon-only row action (`loopStop`).

**Not on track:** succeeded/failed/stopped loops; Claude `/loop`.

### Background Tasks track (expand)

**Membership:** live provider tasks whose type is **not** subagent-family. Include shell, monitor, workflow, and unknown → **Other**.

**Display type**

| Normalized                   | Badge    |
| ---------------------------- | -------- |
| shell / bash / local_bash    | Shell    |
| monitor                      | Monitor  |
| workflow                     | Workflow |
| everything else non-subagent | Other    |

**Row:** type badge + description (command when enriched for shell); status + lastSummary secondary; Stop icon-only; tap → existing `background_task` tab.

**Detail:** shell log-first when `outputFile` present; monitor/workflow/other summary-first with optional log tail. Focus-gated polling unchanged.

**Feature flag:** keep `server_info.features.backgroundTasks`; widen behavior under same flag.

## Architecture

### Principles

1. Adapters fill stores; UI branches on `kind` / normalized type only.
2. Protocol: optional fields, feature flags, dotted RPCs for new pairs; no breaking removals.
3. Multi-host: per-`serverId` client stores (Subagents pattern).
4. Capability missing → track absent, not broken empty.

### Data flow

```
Provider runtime (Claude first)
  · background_tasks_* system events
  · CronCreate / CronList / CronDelete / ScheduleWakeup tool I/O
  · optional session_crons / resume restore signals
        │
        ▼
Provider adapters
  · map → BackgroundTaskStore (non-subagent filter)
  · map → ProviderHeartbeatStore (per parent agent)
        │
ScheduleService (paseo heartbeats)
LoopService (paseo loops; list exposes active worker/verifier)
        │
Session list/push → client stores
        │
useHeartbeatsForParent / useLoopsForParent / useBackgroundTasksForParent
        │
Tracks in agent-panel
```

### Background Tasks (server)

- Replace shell-only gate in `BackgroundTaskStore.replaceLiveSet` and Claude `task_started` mapping with **exclude subagent-family**.
- Keep descriptor shape; retain raw `type` string; client normalizes badge.
- Stop/output RPCs unchanged; EOF policy unchanged.

### Heartbeats (server + client)

- **Paseo:** reuse schedule list/update/pause/resume/delete; filter agent-target for parent.
- **Provider:** new live membership store per `parentAgentId` (mirror provider-subagents / background-tasks).
- **Claude v1 ingestion:** tool_use/tool_result correlation for CronCreate/List/Delete and ScheduleWakeup; refresh list when track focused if partial; prefer any hook/`session_crons` signal the daemon can reach without inventing a PTY. Exact event shapes validated in implementation plan against current Claude SDK.
- **Client:** `useHeartbeatsForParent` merges paseo + provider like `useSubagentsForParent`.
- **Feature:** `server_info.features.providerHeartbeats` for provider side; COMPAT comment + version. Paseo side uses existing schedule RPCs.

### Loops (server + client)

- Extend `loopList` / inspect payloads with optional `activeWorkerAgentId`, `activeVerifierAgentId` (and iteration if cheap) so clients can filter without full inspect per loop.
- Optional agent-scoped list RPC later if global list is too chatty; v1 may filter client-side from enriched list while pane focused.
- Optional push on loop status change — nice-to-have; focused poll acceptable for v1.
- Tab + store + Stop wiring analogous to Background Tasks.

### Error handling

- Provider heartbeat fetch/delete failure: keep paseo rows; surface error on action.
- Loop stop failure: toast / inline; row remains until server says stopped.
- Background stop: existing behavior.
- Unknown background types: show as Other, never drop silently if non-subagent.

## Testing

- Store: include monitor/workflow/other; exclude subagent; shell still works.
- Heartbeat merge: both kinds; actions only on correct kind; empty hide.
- Loop membership: worker-only, verifier-only, neither, terminal status leaves track.
- Protocol: old clients ignore new optional loop fields; new feature flags default false/absent.
- Claude mapper: CronCreate/Delete updates provider heartbeat set; dynamic stop clears row.
- No regression on Subagents / shell Background Tasks.

## Implementation phasing (suggested for plan)

Plans may land in PRs without changing product intent:

1. **Background Tasks expansion** (filter + badges + detail variants) — smallest, reuses path.
2. **Heartbeats track** — paseo rows first, then provider Claude session schedules.
3. **Loops track** — protocol enrich + UI + Stop.

Each phase keeps hide-when-empty and stack order stable (missing tracks simply absent).

## Open implementation risks (resolve in plan, not product)

1. **Reliable Claude session-cron membership** without a public “session_crons changed” stream — may need tool correlation + focused CronList refresh.
2. **Cancel path** for provider rows if only natural-language CronDelete exists today — may require injecting a tool call or documenting open-only until SDK stop exists.
3. **Loop list payload size** if many historical loops — filter `running` server-side if needed.

## Success criteria

- Agent with only a Claude `/loop` shows a **Heartbeats** provider row; no Loops track.
- Agent with only a Paseo agent-target schedule shows a **Heartbeats** paseo row with pause/resume/delete.
- Agent that is active loop worker shows **Loops** with Worker role and Stop.
- Claude monitor appears under **Background Tasks** with Monitor badge; subagent does not.
- Empty agents show no new chrome.
- A future provider can emit the same provider heartbeat / background descriptors without renaming tracks.

## References

- Shipped: `docs/superpowers/specs/2026-08-01-background-tasks-track-design.md`
- [Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)
- Subagents track: `docs/agent-lifecycle.md` (provider vs paseo grammar)
- Glossary: `docs/glossary.md`
