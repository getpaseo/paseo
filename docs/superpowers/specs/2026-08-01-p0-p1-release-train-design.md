# P0/P1 release train — design

**Date:** 2026-08-01  
**Status:** Approved for implementation planning  
**Surface:** Daemon UI-state platform + mobile lock mode + Claude Code orchestration  
**Primary harness:** Claude Code (Codex Goal work explicitly out of scope)

## Problem

Paseo’s product promise is **cross-device orchestration** of coding agents. Several high-value gaps block that:

1. **Composer drafts are device-local** (`AsyncStorage` / `paseo-drafts`). A prompt started on desktop is not available on mobile.
2. **Review drafts are device-local** (`@paseo:review-draft-store`). Inline review comments disappear when switching devices before send.
3. **Mobile monitoring is unsafe.** Watching a running agent on a phone risks accidental taps that stop work, send half-written prompts, or navigate away.
4. **Claude orchestration is incomplete relative to user expectations:**
   - Existing **Fork** is _chat-history attachment → new draft_ (`agent.fork_context`), not a provider-native conversation fork.
   - Mid-turn **steering** exists for OMP (`/steer`) but not as a first-class Claude / product path (queue ≠ steer).

## Goals

Ship **one fork release train** (likely `v0.2.916+`) that:

| Tier                       | Items                                                                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **P0 must (minimum ship)** | Server-side composer drafts; server-side review drafts; lock / read-only mode                                                      |
| **P1 must**                | Claude **native fork**; Claude **steering**                                                                                        |
| **P1 stretch**             | Changes-panel markdown + annotations polish; search in opened file                                                                 |
| **Out of train**           | Codex Goal residuals; voice third-party/headless; todos UI; cron/watchers UI; project-picker polish; `/btw`; diamond beyond drafts |

**Cut rule:** ship when P0 is solid even if a P1 must-item slips. Do not hold the version for stretch.

## Non-goals (this train)

- Codex Goal lifecycle / pause residuals.
- Full multi-provider native fork/steer matrix (Claude first; other providers only if free).
- Replacing the existing fork-context flow entirely (keep it as fallback / non-native providers).
- Perfect CRDT multi-caret editing of drafts; last-write-wins is enough.
- Migrating historical device-local drafts automatically across every device (best-effort optional).
- Android OS screen lock / PIN (in-app interaction lock only).

## Sequencing (Approach A)

```
1. Daemon UI-state platform
   ├─ composer drafts (text-first)
   └─ review drafts (same store + events)
2. Lock / read-only mode (client)
3. Claude native fork (provider session fork → new agent)
4. Claude steering (mid-turn redirect)
5. Stretch: changes markdown, in-file search
```

Each step is independently PR-able and testable. Capability flags gate new RPCs (`server_info.features.*`).

---

## 1. Daemon UI-state platform

### Problem shape

Today:

| State                 | Storage                                   | Scope      |
| --------------------- | ----------------------------------------- | ---------- |
| Composer draft        | Client `AsyncStorage`                     | Per device |
| Review draft comments | Client `AsyncStorage`                     | Per device |
| Attachment blobs      | Client IndexedDB / native files / desktop | Per device |

Target: **daemon-owned ephemeral UI state**, so every client connected to the host sees the same draft/review content.

### Design decisions

| Decision             | Choice                                                                           | Why                                                          |
| -------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Owner                | Daemon under `$PASEO_HOME`                                                       | Same host that owns agents/workspaces; works for all clients |
| Persistence model    | File-based JSON + atomic writes (existing store rules)                           | Matches [docs/data-model.md](../../data-model.md)            |
| Sync model           | LWW (`updatedAt` wins) + push events                                             | Simple; multi-device edits are rare                          |
| Composer MVP payload | **Text + attachment metadata references**; blob upload phase-2 if needed         | Biggest win is text continuity                               |
| Review MVP payload   | Full comment list (path, side, line, body, ids, timestamps)                      | Already small JSON                                           |
| Clear on consume     | Composer clear on successful send; review clear on successful attach/send review | Avoid zombie drafts                                          |
| Capability           | `server_info.features.uiState`                                                   | Feature contract: no degraded fan-out                        |

### Key identity (daemon-side)

Daemon keys **must not** include client `serverId` (that is a client connection id).

**Composer draft keys** (mirror client semantics without `serverId`):

- Agent composer: `agent:{agentId}`
- Explicit draft tab: `draft:{draftId}`
- New-workspace draft: `new-workspace` or `new-workspace:draft:{draftId}`

Client continues to use `buildDraftStoreKey({ serverId, agentId, draftId })` locally for cache keys; the wire key drops `serverId`.

**Review draft keys** (mirror `buildReviewDraftKey` without server prefix):

- `review:workspace={workspaceId}|cwd={cwd}:mode={mode}:base={baseRef}:ignoreWhitespace={bool}`

Prefer `workspaceId` when present (opaque); cwd only as fallback for legacy scopes.

### Wire protocol (sketch)

New dotted RPCs (see [docs/rpc-namespacing.md](../../rpc-namespacing.md)):

```
ui_state.get.request / ui_state.get.response
ui_state.upsert.request / ui_state.upsert.response
ui_state.clear.request / ui_state.clear.response
ui_state.list.request / ui_state.list.response   # optional; hydrate on connect
```

Push (server → clients):

```
ui_state.updated   # { namespace, key, record | null, updatedAt }
```

Record shape (conceptual):

```ts
{
  namespace: "composer" | "review",
  key: string,
  updatedAt: string, // ISO
  // composer:
  text?: string,
  attachments?: Array<{ /* existing attachment metadata; blobs may be host-resident later */ }>,
  lifecycle?: "active" | "abandoned" | "sent",
  // review:
  comments?: Array<{
    id: string,
    filePath: string,
    side: "old" | "new",
    lineNumber: number,
    body: string,
    createdAt: string,
    updatedAt: string,
  }>,
}
```

All new fields optional on the wire for protocol back-compat; feature gated by `uiState`.

### Storage layout

```
$PASEO_HOME/
  ui-state/
    composer/
      {sanitized-key}.json
    review/
      {sanitized-key}.json
```

Store API owns atomicity (read-modify-write inside store methods). No service-level RMW loops.

### Client integration

1. On connect / feature present: hydrate relevant keys for open workspaces/agents (or lazy-get on screen mount).
2. Local zustand stores become **cache + optimistic UI**, not source of truth when `uiState` is available.
3. Writes: debounce text upserts (~200–400ms); immediate upsert on blur/send/navigation; immediate for review comment add/update/delete.
4. Apply `ui_state.updated` if remote `updatedAt` ≥ local.
5. Old daemons: keep current AsyncStorage-only path behind a single capability gate (no dual write complexity beyond “local only”).

### Attachments (phased)

- **Phase A (must):** sync **text** for composer; review comments fully. If attachment metadata cannot be resolved on another device, show a clear “attachment only on the device that added it” affordance rather than failing the whole draft.
- **Phase B (same train if cheap, else next):** host-resident attachment blobs under `$PASEO_HOME/ui-state/assets/` (same pattern as task assets), so images/files survive device switch.

### Conflict & lifecycle

- LWW by `updatedAt`.
- `clear` on send success / review attach success.
- Optional TTL for `sent`/`abandoned` records (e.g. 5 minutes, matching `FINALIZED_DRAFT_TTL_MS`) garbage-collected on upsert/list.

### Tests

- Protocol schema round-trip + optional field defaults.
- Store atomic upsert/get/clear/LWW.
- Client: hydrate → edit → second client receives update; send clears both.
- Capability off: local-only path unchanged.

---

## 2. Lock / read-only mode

### Intent

“I’m monitoring; don’t let fat-fingers break anything.”

### Design decisions

| Decision      | Choice                                                               | Why                                      |
| ------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| Scope         | **Client / device preference**                                       | Lock is personal to the watching device  |
| Effect        | Swallow pointer interactions on dangerous surfaces; keep stream live | Matches backlog wording                  |
| Existing seam | `readOnly` already disables fork handlers in agent stream            | Extend rather than invent parallel flags |
| Persist       | Client preference store (not daemon)                                 | Device-specific                          |

### Behavior

When lock is **on**:

- Composer: no edit, no send, no queue, no voice start, no mode/model changes.
- Agent stream: no rewind, no fork, no tool approval actions, no inline buttons that mutate state.
- Workspace chrome: optional — allow navigation between tabs/workspaces so monitoring remains useful; block archive/stop/kill unless confirmed via an explicit unlock.
- Visual: persistent but quiet banner/chip (“Read-only · tap to unlock”).
- Unlock: single intentional control (banner button); optional long-press on banner for mobile.

When lock is **off**: current behavior.

### Non-goals

- OS-level screen lock / kiosk mode.
- Daemon-enforced read-only for all clients (other devices may still control the agent).

### Tests

- Unit: interaction gate matrix (locked vs unlocked).
- Component: locked composer ignores submit; stream still renders new items.

---

## 3. Claude native fork (P1 must)

### As-is vs target

|                   | Current “Fork”                                                       | Native fork (this train)                                                                       |
| ----------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Mechanism         | `agent.fork_context` → curated history attachment on a **new draft** | Provider **`forkSession`** (Claude Agent SDK) → **new agent session** with forked provider log |
| Mutates original? | No                                                                   | No (forked log)                                                                                |
| Providers         | Any with fork_context capability                                     | Claude first (`supportsNativeFork`)                                                            |
| UI entry          | Turn footer fork menu (tab / new workspace)                          | Same menu, prefer native when available; keep context-fork as fallback                         |

Relevant existing code:

- Client fork UI: `packages/app/src/agent-stream/view.tsx` (`handleForkAssistantTurn`)
- Context RPC: `agent.fork_context.request`
- Claude SDK fork used by rewind: `packages/server/src/server/agent/providers/claude/rewind.ts`

### Design decisions

| Decision                                 | Choice                                                                     | Why                                |
| ---------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------- |
| Product name                             | Keep UI label **Fork**; prefer native under the hood when supported        | Users already know the control     |
| Fallback                                 | Context-fork if `!supportsNativeFork`                                      | No feature loss on other providers |
| Result                                   | New agent in same workspace (tab) or new workspace — same targets as today | Parity with current UX             |
| Capability                               | Provider capability `supportsNativeFork` + daemon feature if new RPC       | Feature contract                   |
| CLI/MCP (“Native fork from harness CLI”) | Follow-up after app path works                                             | App is the daily surface           |

### Wire (sketch)

```
agent.native_fork.request  { agentId, boundary, target: "tab" | "workspace", ... }
agent.native_fork.response { agentId, workspaceId, ... }
```

Server:

1. Resolve source agent (Claude).
2. Call SDK `forkSession` at the chosen boundary (map from Paseo timeline cursor / provider message id — same boundary helpers as rewind/fork_context).
3. Register new agent record + open session on forked provider session id.
4. Return ids for client navigation.

### Tests

- Claude unit/integration: fork creates distinct agent; source unchanged.
- Capability false → UI uses context-fork only.
- Failure surfaces toast; no half-created agent left running (or is archived on failure).

---

## 4. Claude steering (P1 must)

### Intent

Redirect an **in-flight** Claude turn with new instruction **without** treating it as a normal queued follow-up that waits for the turn to finish.

Queue (today): `defaultSendBehavior === "queue" && isAgentRunning` → message waits.  
Steer (target): message influences the **current** turn (interrupt + inject, or provider steer API).

### Design decisions

| Decision            | Choice                                                                                                                          | Why                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Claude v1 mechanism | Interrupt active turn + immediately submit steer text as next user message **marked as steer** (or SDK-equivalent if available) | Aligns with existing interrupt tests; verify against current Agent SDK during implementation |
| OMP                 | Keep existing `/steer` command path                                                                                             | Already works                                                                                |
| UI                  | When agent running: primary action can remain Queue; add explicit **Steer** affordance (toolbar / long-press send / slash)      | Avoid surprising users who rely on queue                                                     |
| Capability          | `supportsSteer` on provider snapshot                                                                                            | Gate UI cleanly                                                                              |
| Non-goal            | Perfect semantic identity with Claude Code TUI `/steer` if SDK differs                                                          | Document actual semantics in UI copy                                                         |

### Wire (sketch)

Prefer reusing prompt path with a flag over a one-off RPC if protocol-clean:

```
agent.prompt with { steer: true }  // optional field, default false
```

or

```
agent.steer.request { agentId, message, attachments? }
agent.steer.response
```

Choose during implementation planning based on how Claude provider run-loop handles interrupt + next message today (`interruptActiveTurn` already exists).

### Tests

- Running agent + steer → active turn stops and new instruction starts without sitting only in queue.
- Provider without capability → steer control hidden; queue unchanged.
- Idle agent → steer disabled or no-ops to normal send.

---

## 5. Stretch (same train if time)

### Changes-panel markdown + annotations

Improve review/diff comment rendering toward GitHub-like readability (markdown bodies, clearer anchors). Builds on existing review draft model; benefits from server-side review drafts (#1).

### Search in opened file

Find-in-file for the file preview/editor surface (Cmd/Ctrl-F). Local UI feature; no daemon dependency.

Neither blocks the release cut.

---

## Capability & protocol rules

- New RPCs: dotted names + `.request`/`.response`.
- New daemon feature flags: `server_info.features.uiState`, plus any fork/steer flags if not fully covered by provider capabilities.
- `COMPAT(name)` comments with version + ~6 month cleanup target.
- No degraded multi-RPC fan-out for new features on old daemons — gate once, show “Update the host to use this” where appropriate (lock mode needs no host update).

## Success criteria

| Criterion           | Evidence                                                                                |
| ------------------- | --------------------------------------------------------------------------------------- |
| Cross-device prompt | Type on desktop → open same agent on mobile → text present                              |
| Cross-device review | Add review comment on desktop → see on mobile → send once                               |
| Safe mobile watch   | Lock on → taps do not send/stop/fork; stream still updates                              |
| Native fork         | Claude turn footer Fork creates a new agent with forked provider session when supported |
| Steer               | Claude running turn accepts steer and changes course without only queuing               |
| Ship discipline     | Fork release notes list P0; slipped P1 called out as follow-up                          |

## Risks

| Risk                                                | Mitigation                                    |
| --------------------------------------------------- | --------------------------------------------- |
| Attachment blob portability hard                    | Phase A text-first; Phase B assets            |
| Claude SDK fork/steer semantics differ from UI copy | Spike early in P1 tasks; adjust copy to truth |
| LWW overwrites concurrent desktop+mobile typing     | Debounce + accept LWW; rare in practice       |
| Scope creep into full CRDT / multi-provider matrix  | Hard non-goals list; cut rule                 |

## Open questions (resolve during implementation planning, not blockers for this design)

1. Exact Claude Agent SDK API for steer vs interrupt+prompt (spike).
2. Whether native fork boundary uses provider message id only or also timeline cursor (likely both, matching rewind).
3. Whether composer attachment Phase B lands in this train or next.

## Implementation plans

Written after approval:

1. [docs/superpowers/plans/2026-08-01-ui-state-platform.md](../plans/2026-08-01-ui-state-platform.md) — P0 platform + client wiring
2. [docs/superpowers/plans/2026-08-01-lock-readonly-mode.md](../plans/2026-08-01-lock-readonly-mode.md) — P0 lock
3. [docs/superpowers/plans/2026-08-01-claude-native-fork.md](../plans/2026-08-01-claude-native-fork.md) — P1 fork
4. [docs/superpowers/plans/2026-08-01-claude-steering.md](../plans/2026-08-01-claude-steering.md) — P1 steer

Stretch items get plans only if started in-train.
