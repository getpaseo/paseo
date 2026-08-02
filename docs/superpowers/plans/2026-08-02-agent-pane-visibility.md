# Agent Pane Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand agent-pane visibility so users see Heartbeats (Paseo + provider session schedules including Claude CronCreate/`/loop`), Paseo Loops (worker/verifier), and non-shell Background Tasks (monitor/workflow/other), stacked Queue → Subagents → Heartbeats → Loops → Background Tasks.

**Architecture:** Three additive surfaces on the existing Subagents / Background Tasks grammar. (1) Widen `BackgroundTaskStore` from shell-only to non-subagent with type badges. (2) New Heartbeats track merges Paseo agent-target schedules with a new provider session-schedule live set (`kind: "paseo" | "provider"`). (3) New Loops track filters enriched `loop/list` by active worker/verifier agent ids. Claude is the first provider adapter only — kinds stay `provider` + `AgentProvider`.

**Tech Stack:** TypeScript monorepo (`packages/protocol`, `packages/server`, `packages/client`, `packages/app`), Zod wire schemas, Vitest, Zustand, Expo/React Native, Claude Agent SDK tool/system events.

**Spec:** `docs/superpowers/specs/2026-08-02-agent-pane-visibility-design.md`

## Global Constraints

- Protocol stays backward-compatible: new fields `.optional()`, new RPCs only, no required flips, no plain `z.union` when a shared tag exists (use `z.discriminatedUnion`).
- New RPCs use dotted namespaces with `.request`/`.response` per `docs/rpc-namespacing.md`.
- Feature flags: keep `backgroundTasks`; add `providerHeartbeats` with `// COMPAT(providerHeartbeats): added in v0.2.x, remove gate after 2027-02-01` (adjust date to +6 months from ship).
- No full monorepo test suite; only targeted files: `npx vitest run <file> --bail=1`.
- Always `npm run typecheck`, `npm run lint`, `npm run format` (or `format:files`) before commits that touch code.
- Rebuild when cross-package types lag: `npm run build:client` / `npm run build:server`.
- Hide tracks when empty; never hardcode product `kind: "claude"` — use `kind: "provider"` + `provider`.
- Claude `/loop` and CronCreate → **Heartbeats** provider rows, never **Loops**.
- Never restart the daemon on port 6767 without permission.
- Prefer graph tools before blind Grep when exploring; fall back to Grep/Read for file-local work.

## File map

| Area                         | Files                                                                                                            |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Background filter            | `packages/server/src/server/agent/background-tasks/store.ts` (+ test), `.../claude/background-tasks.ts` (+ test) |
| Background UI                | `packages/app/src/background-tasks/track.tsx`, `select.ts`, i18n resources                                       |
| Loop protocol                | `packages/protocol/src/loop/rpc-schemas.ts` (+ tests if present)                                                 |
| Loop server                  | `packages/server/src/server/loop-service.ts` (+ test)                                                            |
| Loops app                    | Create `packages/app/src/loops/*`, panel, tab model, mount in `agent-panel.tsx`                                  |
| Provider heartbeats protocol | `packages/protocol/src/messages.ts` (+ schema test), websocket feature flag                                      |
| Provider heartbeats server   | Create `packages/server/src/server/agent/provider-heartbeats/*`, Claude mapper, agent-manager/session handlers   |
| Provider heartbeats client   | `packages/client/src/daemon-client.ts`                                                                           |
| Heartbeats app               | Create `packages/app/src/heartbeats/*`, mount in `agent-panel.tsx`                                               |
| Session push                 | `packages/app/src/contexts/session-context.tsx` (or existing push dispatch site)                                 |
| Docs                         | `docs/glossary.md`                                                                                               |

## Suggested PR / ship order

Implement tasks in order. Safe mid-stack ship points after Tasks 2, 5, and 9.

---

### Task 1: Background Tasks — non-subagent membership (server)

**Files:**

- Modify: `packages/server/src/server/agent/background-tasks/store.ts`
- Modify: `packages/server/src/server/agent/background-tasks/store.test.ts`
- Modify: `packages/server/src/server/agent/providers/claude/background-tasks.ts`
- Modify: `packages/server/src/server/agent/providers/claude/background-tasks.test.ts`

**Interfaces:**

- Consumes: existing `BackgroundTaskLiveMember`, `BackgroundTaskStore`
- Produces:
  - `isSubagentTaskType(type: string): boolean` — true for `subagent` (and any documented aliases found in fixtures; start with exact `subagent` case-insensitive)
  - `isTrackableBackgroundTaskType(type: string): boolean` — `!isSubagentTaskType(type)`
  - Keep `isShellTaskType` for badge/helpers if useful; **stop using it as the membership gate**
  - `replaceLiveSet` includes all non-subagent members
  - `mapTaskStartedEvent` no longer returns null solely for non-shell types

- [ ] **Step 1: Write failing store tests**

In `store.test.ts`, add:

```ts
it("includes monitor and workflow and excludes subagent", () => {
  const store = new BackgroundTaskStore();
  const tasks = store.replaceLiveSet(
    "parent-1",
    [
      { taskId: "s1", type: "shell", description: "npm run dev" },
      { taskId: "m1", type: "monitor", description: "watch deploy" },
      { taskId: "w1", type: "workflow", description: "review-changes" },
      { taskId: "a1", type: "subagent", description: "Explore" },
      { taskId: "o1", type: "mystery", description: "other work" },
    ],
    "2026-08-02T00:00:00.000Z",
  );
  expect(tasks.map((t) => t.taskId).sort()).toEqual(["m1", "o1", "s1", "w1"]);
  expect(isSubagentTaskType("subagent")).toBe(true);
  expect(isTrackableBackgroundTaskType("monitor")).toBe(true);
  expect(isTrackableBackgroundTaskType("subagent")).toBe(false);
});
```

Update any existing test that asserted shell-only replace behavior (the test named like “replaces live set from background_tasks_changed shell-only” in the Claude mapper tests).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/agent/background-tasks/store.test.ts --bail=1`  
Expected: FAIL — `isSubagentTaskType` / non-shell inclusion missing.

- [ ] **Step 3: Implement membership helpers + store gate**

In `store.ts`:

```ts
export function isSubagentTaskType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized === "subagent";
}

export function isTrackableBackgroundTaskType(type: string): boolean {
  return !isSubagentTaskType(type);
}
```

In `replaceLiveSet`, replace `if (!isShellTaskType(task.type)) continue;` with `if (!isTrackableBackgroundTaskType(task.type)) continue;`.

In Claude `mapTaskStartedEvent`, remove the `if (!isShellTaskType(type)) return null;` gate (or replace with subagent exclusion only). Ensure `background_tasks_changed` mapping already forwards all types into `replaceLiveSet` (store filters).

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run packages/server/src/server/agent/background-tasks/store.test.ts --bail=1
npx vitest run packages/server/src/server/agent/providers/claude/background-tasks.test.ts --bail=1
```

Expected: PASS. Update Claude tests that still expect shell-only replace.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/background-tasks packages/server/src/server/agent/providers/claude/background-tasks.ts packages/server/src/server/agent/providers/claude/background-tasks.test.ts
git commit -m "feat(server): track non-subagent Claude background tasks"
```

---

### Task 2: Background Tasks — type badges in app

**Files:**

- Modify: `packages/app/src/background-tasks/track.tsx`
- Create or modify: `packages/app/src/background-tasks/type-badge.ts` (+ test optional)
- Modify: i18n locale files under `packages/app/src/i18n/resources/` (at least `en` / default used by app)
- Modify: `docs/glossary.md` Background Tasks bullet (shell-only → non-subagent)

**Interfaces:**

- Consumes: `BackgroundTaskDescriptor` / row with `type: string`
- Produces:

```ts
export type BackgroundTaskDisplayType = "shell" | "monitor" | "workflow" | "other";

export function normalizeBackgroundTaskDisplayType(type: string): BackgroundTaskDisplayType {
  const n = type.trim().toLowerCase();
  if (n === "shell" || n === "bash" || n === "local_bash") return "shell";
  if (n === "monitor") return "monitor";
  if (n === "workflow") return "workflow";
  return "other";
}
```

- [ ] **Step 1: Unit test normalizer**

Create `packages/app/src/background-tasks/type-badge.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeBackgroundTaskDisplayType } from "./type-badge";

describe("normalizeBackgroundTaskDisplayType", () => {
  it("maps known types", () => {
    expect(normalizeBackgroundTaskDisplayType("shell")).toBe("shell");
    expect(normalizeBackgroundTaskDisplayType("bash")).toBe("shell");
    expect(normalizeBackgroundTaskDisplayType("monitor")).toBe("monitor");
    expect(normalizeBackgroundTaskDisplayType("workflow")).toBe("workflow");
    expect(normalizeBackgroundTaskDisplayType("mystery")).toBe("other");
  });
});
```

- [ ] **Step 2: Run to fail, then implement `type-badge.ts`, re-run**

Run: `npx vitest run packages/app/src/background-tasks/type-badge.test.ts --bail=1`

- [ ] **Step 3: Render badge in track row**

In `track.tsx` row layout, before the primary label, render a compact badge Text (reuse muted chip styling from nearby UI if one exists; else a small `Text` with border/padding using theme tokens from Unistyles — follow Subagents density, no new design system).

i18n keys (example):

- `backgroundTasks.typeShell` → `Shell`
- `backgroundTasks.typeMonitor` → `Monitor`
- `backgroundTasks.typeWorkflow` → `Workflow`
- `backgroundTasks.typeOther` → `Other`

Primary label remains command/description as today.

- [ ] **Step 4: Glossary**

Update `docs/glossary.md` Background Tasks entry to: live long-running provider work that is not a subagent (shell, monitor, workflow, other); v1 producer Claude Code.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
npm run format:files -- packages/app/src/background-tasks docs/glossary.md
git add packages/app/src/background-tasks packages/app/src/i18n docs/glossary.md
git commit -m "feat(app): badge Background Tasks by type"
```

---

### Task 3: Loop list — optional active agent fields (protocol + server)

**Files:**

- Modify: `packages/protocol/src/loop/rpc-schemas.ts`
- Modify: `packages/server/src/server/loop-service.ts`
- Modify: `packages/server/src/server/loop-service.test.ts` (or add cases)
- Modify: any client types inferred from schemas (usually automatic after rebuild)

**Interfaces:**

- Produces: `LoopListItemSchema` gains:

```ts
activeWorkerAgentId: z.string().nullable().optional(),
activeVerifierAgentId: z.string().nullable().optional(),
```

(Use `.optional()` so old clients ignore; server always sends them when listing.)

- `LoopService.listLoops()` maps:

```ts
activeWorkerAgentId: record.activeWorkerAgentId,
activeVerifierAgentId: record.activeVerifierAgentId,
```

- [ ] **Step 1: Failing test in loop-service**

Assert `listLoops()` for a running loop includes worker/verifier ids after a run is stubbed/set. Prefer extending an existing unit test that creates a loop record in memory if available; otherwise unit-test the map by setting private state via public `runLoop` mocks carefully. Minimal approach: after `initialize`, push a synthetic record if tests already do that — match existing test style in `loop-service.test.ts`.

- [ ] **Step 2: Implement schema + list mapping**

- [ ] **Step 3: Run**

```bash
npx vitest run packages/server/src/server/loop-service.test.ts --bail=1
npm run build:client   # if app needs updated declarations
```

- [ ] **Step 4: Commit**

```bash
git add packages/protocol/src/loop packages/server/src/server/loop-service.ts packages/server/src/server/loop-service.test.ts
git commit -m "feat(protocol): expose loop active worker/verifier on list"
```

---

### Task 4: Loops track — client select + store

**Files:**

- Create: `packages/app/src/loops/select.ts`
- Create: `packages/app/src/loops/select.test.ts`
- Create: `packages/app/src/loops/store.ts` (Zustand per serverId → loops list cache, optional)

**Interfaces:**

```ts
export type LoopRole = "worker" | "verifier";

export interface LoopTrackRow {
  loopId: string;
  name: string | null;
  promptPreview: string | null; // optional if list lacks prompt; use name/id
  role: LoopRole;
  activeIteration: number | null;
  status: "running";
}

export function selectLoopsForAgent(input: {
  agentId: string;
  loops: Array<{
    id: string;
    name: string | null;
    status: string;
    activeIteration: number | null;
    activeWorkerAgentId?: string | null;
    activeVerifierAgentId?: string | null;
  }>;
}): LoopTrackRow[] {
  const rows: LoopTrackRow[] = [];
  for (const loop of input.loops) {
    if (loop.status !== "running") continue;
    if (loop.activeWorkerAgentId === input.agentId) {
      rows.push({
        loopId: loop.id,
        name: loop.name,
        promptPreview: null,
        role: "worker",
        activeIteration: loop.activeIteration,
        status: "running",
      });
      continue;
    }
    if (loop.activeVerifierAgentId === input.agentId) {
      rows.push({
        loopId: loop.id,
        name: loop.name,
        promptPreview: null,
        role: "verifier",
        activeIteration: loop.activeIteration,
        status: "running",
      });
    }
  }
  return rows;
}
```

- [ ] **Step 1: Failing select tests** (worker, verifier, neither, non-running)

- [ ] **Step 2: Implement select (+ thin store that calls `client.loopList()` and caches)**

Store pattern: mirror `background-tasks/store.ts` simplicity — `refreshLoops(client, serverId)`, map response through schema, store array.

- [ ] **Step 3: Run tests + commit**

```bash
npx vitest run packages/app/src/loops/select.test.ts --bail=1
git add packages/app/src/loops
git commit -m "feat(app): select loops for active worker/verifier agent"
```

---

### Task 5: Loops track UI + tab + Stop + agent-panel mount

**Files:**

- Create: `packages/app/src/loops/track.tsx`
- Create: `packages/app/src/loops/use-stop-loop.ts`
- Create: `packages/app/src/panels/loop-panel.tsx`
- Modify: workspace tab model/identity/register-panels (same files Background Tasks touched — search `background_task` kind and clone for `loop`)
- Modify: `packages/app/src/panels/agent-panel.tsx` — stack order
- Modify: i18n keys `loops.*`

**Interfaces:**

- Tab kind: `loop` with `{ loopId: string }` (plus serverId via workspace context as other tabs)
- Open: `openTab({ kind: "loop", loopId })`
- Stop: `client.loopStop(loopId)` then refresh list
- Panel: show status, role if known, active iteration, log tail via `client.loopLogs` (poll while focused, similar to background-task output hook — keep simple: refresh on focus + interval ~1s while focused)

**Agent-panel order (critical):**

```tsx
{/* existing Queue is inside Composer; tracks above composer: */}
<SubagentsTrack ... />
{/* Heartbeats later */}
{supportsLoops ? <LoopsTrack ... /> : null}
{supportsBackgroundTasks ? <BackgroundTasksTrack ... /> : null}
```

For this task, mount Loops **above** Background Tasks. Heartbeats slot is empty until Task 9.

`supportsLoops`: treat loop RPCs as always present on modern daemons OR gate on a feature if one exists; if no feature flag today, call `loopList` and hide on error / empty. Prefer adding `server_info.features.loops?: boolean` only if other loop UI already needs it — otherwise YAGNI and just use list.

- [ ] **Step 1: Add tab kind + panel registration** (copy background_task wiring)

- [ ] **Step 2: Implement `LoopsTrack` chrome** (clone Subagents/Background structure)

Row: primary name/id; secondary `Worker`/`Verifier` + iteration; Stop icon-only when running.

- [ ] **Step 3: Mount + refresh on agent focus**

When agent panel mounts / agentId changes, `refreshLoops(client, serverId)`.

- [ ] **Step 4: Manual typecheck + commit**

```bash
npm run build:client
npm run typecheck
npm run format:files -- packages/app/src/loops packages/app/src/panels packages/app/src/workspace-tabs packages/app/src/i18n
git add packages/app
git commit -m "feat(app): Loops track and inspect tab for agent pane"
```

---

### Task 6: Provider heartbeats — protocol + feature flag

**Files:**

- Modify: `packages/protocol/src/messages.ts` (near background_tasks / provider_subagents)
- Create: `packages/protocol/src/provider-heartbeats-schema.test.ts`
- Modify: `packages/server/src/server/websocket-server.ts` features object

**Interfaces — produce:**

```ts
export const ProviderHeartbeatModeSchema = z.enum(["recurring", "one_shot", "dynamic"]);

export const ProviderHeartbeatDescriptorPayloadSchema = z.object({
  taskId: z.string().min(1),
  parentAgentId: z.string().min(1), // guid if other agents use guid; match BackgroundTask parentAgentId style
  provider: AgentProviderSchema, // existing schema
  prompt: z.string(),
  mode: ProviderHeartbeatModeSchema,
  scheduleLabel: z.string(), // humanized cron or "self-paced"
  nextHint: z.string().nullable(),
  updatedAt: z.string(),
});

// RPCs (dotted):
// agent.provider_heartbeats.list.request / .list.response
// agent.provider_heartbeats.update  (push full replace for parentAgentId)
// agent.provider_heartbeats.delete.request / .delete.response
```

Feature: `server_info.features.providerHeartbeats: z.boolean().optional()` + server sets `true` with COMPAT comment.

Delete response shape:

```ts
{
  requestId: string;
  parentAgentId: string;
  taskId: string;
  error: string | null;
}
```

- [ ] **Step 1: Failing schema test** (parse list request/response + update push + feature optional)

- [ ] **Step 2: Add schemas to inbound/outbound unions + regenerate validators** (`npm run typecheck` triggers pretypecheck)

- [ ] **Step 3: Advertise feature on websocket server_info**

- [ ] **Step 4: Commit**

```bash
git add packages/protocol packages/server/src/server/websocket-server.ts
git commit -m "feat(protocol): provider heartbeats list/update/delete RPCs"
```

---

### Task 7: Provider heartbeats — server store + Claude session-schedule adapter

**Files:**

- Create: `packages/server/src/server/agent/provider-heartbeats/store.ts`
- Create: `packages/server/src/server/agent/provider-heartbeats/store.test.ts`
- Create: `packages/server/src/server/agent/providers/claude/provider-heartbeats.ts`
- Create: `packages/server/src/server/agent/providers/claude/provider-heartbeats.test.ts`
- Modify: `packages/server/src/server/agent/providers/claude/agent.ts` — dispatch tool results / clear on session end
- Modify: `packages/server/src/server/agent/agent-manager.ts` — list/delete + push hook
- Modify: `packages/server/src/server/session.ts` — RPC handlers

**Interfaces:**

```ts
// store.ts
export interface ProviderHeartbeatDescriptor {
  taskId: string;
  parentAgentId: string;
  provider: AgentProvider; // "claude" etc.
  prompt: string;
  mode: "recurring" | "one_shot" | "dynamic";
  scheduleLabel: string;
  nextHint: string | null;
  updatedAt: string;
}

export class ProviderHeartbeatStore {
  replaceLiveSet(
    parentAgentId: string,
    tasks: ProviderHeartbeatDescriptor[],
  ): ProviderHeartbeatDescriptor[];
  upsert(parentAgentId: string, task: ProviderHeartbeatDescriptor): void;
  remove(parentAgentId: string, taskId: string): boolean;
  list(parentAgentId: string): ProviderHeartbeatDescriptor[];
  deleteParent(parentAgentId: string): void;
}
```

**Claude mapping rules (v1):**

1. On tool result for tools named (case-insensitive) `CronCreate`, `cron_create`: upsert from input `{ cron, prompt, recurring? }` and result id if present.
2. On `CronDelete` / `cron_delete`: remove by id from input.
3. On `CronList` / `cron_list` result: if result is an array of tasks, `replaceLiveSet` from full list.
4. On `ScheduleWakeup`: if `stop: true`, remove dynamic task if correlated; if delay provided, upsert/update `mode: "dynamic"`, `scheduleLabel: "self-paced"`, `nextHint` from delay/reason fields when present.
5. On agent clear/close: `deleteParent`.

If tool payloads differ in the wild, tests lock the shapes you implement; add unwrap helpers like background-tasks nested output.

**Delete RPC:** Prefer asking Claude runtime to cancel if a public API exists; if not, remove from **Paseo live set only** and return error string `"Provider cancel is not available; removed from Paseo view only"` **or** document open-only and make delete return error without remove — **spec prefers real CronDelete**. Implementation choice for v1: attempt in-process cancel if agent exposes stopTask-like for cron; else keep row and return clear error so UI can disable delete. **Minimum:** list + push accurate; delete best-effort.

**Push:** same pattern as background_tasks.update — manager notifies sessions on store change.

- [ ] **Step 1: Store unit tests** (replace, upsert, remove, list)

- [ ] **Step 2: Claude mapper unit tests** with fixture tool messages

- [ ] **Step 3: Wire agent.ts + agent-manager + session handlers**

- [ ] **Step 4: Run targeted tests + typecheck server**

```bash
npx vitest run packages/server/src/server/agent/provider-heartbeats --bail=1
npx vitest run packages/server/src/server/agent/providers/claude/provider-heartbeats.test.ts --bail=1
npm run build:server
```

- [ ] **Step 5: Commit**

```bash
git add packages/server
git commit -m "feat(server): provider heartbeats store and Claude session schedule mapping"
```

---

### Task 8: Provider heartbeats — client methods + app store

**Files:**

- Modify: `packages/client/src/daemon-client.ts`
- Create: `packages/app/src/heartbeats/provider-store.ts` (+ test)
- Modify: session push handler to apply `agent.provider_heartbeats.update`

**Interfaces:**

```ts
// DaemonClient
listProviderHeartbeats(parentAgentId: string): Promise<{ tasks: ProviderHeartbeatDescriptorPayload[]; error: string | null }>;
deleteProviderHeartbeat(parentAgentId: string, taskId: string): Promise<{ error: string | null }>;
// subscribe via existing session message pump — no separate subscribe RPC if push is global like background tasks
```

- [ ] **Step 1: Client methods** matching request/response types

- [ ] **Step 2: App provider-store** mirror `subagents/provider-store.ts` or `background-tasks/store.ts`

- [ ] **Step 3: Session context dispatch on update type**

- [ ] **Step 4: `npm run build:client` + typecheck + commit**

```bash
git add packages/client packages/app/src/heartbeats packages/app/src/contexts
git commit -m "feat(client): provider heartbeats list/delete and app store"
```

---

### Task 9: Heartbeats track — merge Paseo + provider, UI, actions, mount

**Files:**

- Create: `packages/app/src/heartbeats/select.ts` (+ test)
- Create: `packages/app/src/heartbeats/track.tsx`
- Create: `packages/app/src/heartbeats/use-heartbeat-actions.ts` (pause/resume/delete paseo; delete provider)
- Modify: `packages/app/src/panels/agent-panel.tsx` — mount **between Subagents and Loops**
- Reuse: schedule form sheet for paseo open; simple detail modal/sheet for provider open
- i18n: `heartbeats.*`
- Glossary: Heartbeat entry includes provider session schedules; Claude `/loop` → Heartbeats not Loops

**Interfaces:**

```ts
export type HeartbeatRow =
  | {
      kind: "paseo";
      id: string;
      name: string | null;
      prompt: string;
      status: "active" | "paused";
      cadenceLabel: string;
      nextRunAt: string | null;
      serverId: string;
    }
  | {
      kind: "provider";
      id: string;
      parentAgentId: string;
      provider: Agent["provider"];
      prompt: string;
      mode: "recurring" | "one_shot" | "dynamic";
      scheduleLabel: string;
      nextHint: string | null;
    };

export function mergeHeartbeatRows(
  paseo: HeartbeatRow[],
  provider: HeartbeatRow[],
): HeartbeatRow[] {
  return [...paseo, ...provider];
}
```

**Paseo source:** `client.scheduleList()` (or existing schedules hook data for `serverId`) filtered:

```ts
schedule.target.type === "agent" &&
  schedule.target.agentId === agentId &&
  (schedule.status === "active" || schedule.status === "paused");
```

**Actions:**

- Paseo: `schedulePause` / `scheduleResume` / `scheduleDelete` (exact client method names already on DaemonClient — use those from schedules screen)
- Open paseo: existing edit heartbeat form path used by schedules UI
- Provider: open read-only detail; delete via `deleteProviderHeartbeat` when feature true

**Track chrome:** Subagents-like; header `Heartbeats` / count; provider leading icon via `getProviderIcon(row.provider)`; paseo use a calendar/clock lucide icon.

**Capability:** show track if (paseo rows possible — schedules work) OR `features.providerHeartbeats`. Hide when merged rows empty.

- [ ] **Step 1: Select tests** (paseo filter, provider map, merge)

- [ ] **Step 2: Track UI + actions**

- [ ] **Step 3: Mount in agent-panel between Subagents and Loops**

```tsx
<SubagentsTrack ... />
{showHeartbeatsTrack ? <HeartbeatsTrack ... /> : null}
{showLoopsTrack ? <LoopsTrack ... /> : null}
{supportsBackgroundTasks ? <BackgroundTasksTrack ... /> : null}
```

- [ ] **Step 4: Glossary + typecheck + commit**

```bash
npm run typecheck
npm run format:files -- packages/app/src/heartbeats packages/app/src/panels/agent-panel.tsx docs/glossary.md
git add packages/app docs/glossary.md
git commit -m "feat(app): Heartbeats track for paseo and provider session schedules"
```

---

### Task 10: End-to-end verification + polish

**Files:** any small fixes discovered; ensure i18n keys complete.

- [ ] **Step 1: Targeted test battery**

```bash
npx vitest run packages/server/src/server/agent/background-tasks --bail=1
npx vitest run packages/server/src/server/agent/providers/claude/background-tasks.test.ts --bail=1
npx vitest run packages/server/src/server/agent/provider-heartbeats --bail=1
npx vitest run packages/server/src/server/agent/providers/claude/provider-heartbeats.test.ts --bail=1
npx vitest run packages/server/src/server/loop-service.test.ts --bail=1
npx vitest run packages/protocol/src/provider-heartbeats-schema.test.ts --bail=1
npx vitest run packages/protocol/src/background-tasks-schema.test.ts --bail=1
npx vitest run packages/app/src/background-tasks --bail=1
npx vitest run packages/app/src/loops --bail=1
npx vitest run packages/app/src/heartbeats --bail=1
```

- [ ] **Step 2: Full typecheck + lint**

```bash
npm run build:client
npm run typecheck
npm run lint
```

- [ ] **Step 3: Spec success criteria checklist**

- [ ] Claude `/loop` alone → Heartbeats provider row; no Loops track
- [ ] Paseo agent-target schedule → Heartbeats paseo row with pause/resume/delete
- [ ] Active loop worker → Loops Worker + Stop
- [ ] Monitor → Background Tasks Monitor badge; subagent not listed there
- [ ] Empty agent → no new chrome
- [ ] Stack order: Subagents → Heartbeats → Loops → Background Tasks

- [ ] **Step 4: Final commit if polish remains**

```bash
git add -A
git commit -m "chore: polish agent pane visibility package"
```

---

## Spec coverage (self-review)

| Spec requirement                         | Task                 |
| ---------------------------------------- | -------------------- |
| Background non-subagent membership       | 1                    |
| Type badges Shell/Monitor/Workflow/Other | 2                    |
| Glossary Background Tasks update         | 2, 10                |
| Loop list worker/verifier fields         | 3                    |
| Loops membership + track + open + Stop   | 4–5                  |
| Claude `/loop` not on Loops              | 5, 9 (select rules)  |
| Heartbeats paseo \| provider grammar     | 6–9                  |
| No `kind: "claude"`                      | 6–9 interfaces       |
| Provider extensibility                   | 6–7 store/protocol   |
| CronCreate / ScheduleWakeup mapping      | 7                    |
| Paseo pause/resume/delete                | 9                    |
| Track order                              | 5, 9                 |
| Hide when empty                          | all track components |
| Feature `providerHeartbeats`             | 6                    |
| Protocol backward compatible             | 3, 6                 |

## Risks carried into implementation

1. Claude tool payload shapes for Cron\* may need fixture capture from a live session — adjust mapper tests once real payloads are known; do not block list UI on perfect cancel.
2. Provider delete may be view-only in v1 if CronDelete cannot be invoked from daemon — surface error, keep list honest.
3. `loop/list` without server-side running filter is fine for small N; add filter later if needed.

## Out of scope (do not implement in this plan)

- New-agent Schedules on agent pane
- Codex Goal / cloud Routines / Desktop scheduled tasks
- Merging Heartbeats + Loops labels
- Always-on empty track CTAs
