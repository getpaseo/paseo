# Background Tasks Track Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show Claude Code long-running shell background processes in a collapsible agent-pane track under Subagents, with icon-only Stop on the row and a detail tab whose logs refresh only while that tab is focused.

**Architecture:** Mirror provider-subagents end-to-end. The Claude adapter maintains a live shell-task set from SDK system messages (`background_tasks_changed` replace + start/progress/notification enrichment), exposes it through dotted RPCs and push updates, and tails output files only for focus-subscribed clients. The app keeps a per-agent store, mounts a Subagents-like track, and opens a new workspace tab kind for details/logs.

**Tech Stack:** TypeScript monorepo (`packages/protocol`, `packages/server`, `packages/client`, `packages/app`), Zod wire schemas, Vitest, Zustand, Expo/React Native UI, Claude Agent SDK.

**Spec:** `docs/superpowers/specs/2026-08-01-background-tasks-track-design.md`

## Global Constraints

- Protocol stays backward-compatible: new fields `.optional()`, new RPCs only, no required flips.
- New RPCs use dotted namespaces with `.request`/`.response` pairs per `docs/rpc-namespacing.md`.
- Feature gate: `server_info.features.backgroundTasks` with `// COMPAT(backgroundTasks): ...` cleanup comment.
- No full monorepo test suite; run only targeted files: `npx vitest run <file> --bail=1`.
- Always `npm run typecheck`, `npm run lint`, `npm run format` before commits that touch code.
- Rebuild stacks when cross-package types lag: `npm run build:client` / `npm run build:server` as needed.
- v1 is Claude shell tasks only; hide track when empty; Stop is track icon-only (not in tab); logs poll only while the detail tab is focused/visible.
- Never restart the daemon on port 6767 without permission.

## File map

| Area           | Files                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol       | `packages/protocol/src/messages.ts` (schemas + feature flag), validators regen                                                              |
| Server store   | Create `packages/server/src/server/agent/background-tasks/store.ts` (+ test)                                                                |
| Claude adapter | `packages/server/src/server/agent/providers/claude/agent.ts`, create `.../claude/background-tasks.ts` (+ test)                              |
| Agent manager  | `packages/server/src/server/agent/agent-manager.ts`                                                                                         |
| Session / WS   | `packages/server/src/server/session.ts`, `packages/server/src/server/websocket-server.ts`                                                   |
| Client         | `packages/client/src/daemon-client.ts`                                                                                                      |
| App store      | Create `packages/app/src/background-tasks/*`                                                                                                |
| Track UI       | Create `packages/app/src/background-tasks/track.tsx`, mount in `packages/app/src/panels/agent-panel.tsx`                                    |
| Tab/panel      | `packages/app/src/workspace-tabs/model.ts`, `identity.ts`, create `packages/app/src/panels/background-task-panel.tsx`, `register-panels.ts` |
| Session wiring | `packages/app/src/contexts/session-context.tsx`                                                                                             |
| Docs / i18n    | `docs/glossary.md`, app locale files under `packages/app/src/i18n/resources/`                                                               |

---

### Task 1: Protocol schemas + feature flag

**Files:**

- Modify: `packages/protocol/src/messages.ts` (features object near `providerSubagents`, new message schemas near provider-subagent RPCs)
- Modify: `packages/protocol/src/client-capabilities.ts` only if a client-capability gate is required for push (prefer server feature only unless push filtering needs a client cap; default: server feature only)
- Test: `packages/protocol/src/messages.tool-call-schema.test.ts` or add `packages/protocol/src/background-tasks-schema.test.ts` if message parsing needs a dedicated file
- Run protocol validator codegen via package pretypecheck

**Interfaces:**

- Produces:
  - `BackgroundTaskDescriptorPayloadSchema` / `BackgroundTaskDescriptorPayload`
  - `BackgroundTaskStatusSchema`: `"running" | "completed" | "failed" | "stopped" | "unknown"`
  - Message types:
    - `agent.background_tasks.list.request` / `.list.response`
    - `agent.background_tasks.update` (push; payload includes `parentAgentId` + `tasks[]` full replace)
    - `agent.background_tasks.stop.request` / `.stop.response`
    - `agent.background_tasks.output.get.request` / `.output.get.response`
    - `agent.background_tasks.output.subscribe.request` / `.output.subscribe.response`
    - `agent.background_tasks.output.unsubscribe.request` / `.output.unsubscribe.response`
    - `agent.background_tasks.output.update` (push chunk)
  - `server_info.features.backgroundTasks?: boolean` with COMPAT comment dated ~6 months out

- [ ] **Step 1: Write failing schema test**

Create `packages/protocol/src/background-tasks-schema.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BackgroundTaskDescriptorPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("background task wire schemas", () => {
  it("accepts a shell task descriptor", () => {
    const parsed = BackgroundTaskDescriptorPayloadSchema.parse({
      taskId: "bg-1",
      parentAgentId: "00000000-0000-4000-8000-000000000001",
      type: "shell",
      description: "Dev server",
      command: "npm run dev",
      status: "running",
      outputFile: null,
      lastSummary: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parsed.taskId).toBe("bg-1");
    expect(parsed.status).toBe("running");
  });

  it("parses list request/response and update push", () => {
    const request = SessionInboundMessageSchema.parse({
      type: "agent.background_tasks.list.request",
      requestId: "r1",
      parentAgentId: "00000000-0000-4000-8000-000000000001",
    });
    expect(request.type).toBe("agent.background_tasks.list.request");

    const response = SessionOutboundMessageSchema.parse({
      type: "agent.background_tasks.list.response",
      payload: {
        requestId: "r1",
        parentAgentId: "00000000-0000-4000-8000-000000000001",
        tasks: [],
        error: null,
      },
    });
    expect(response.type).toBe("agent.background_tasks.list.response");

    const update = SessionOutboundMessageSchema.parse({
      type: "agent.background_tasks.update",
      payload: {
        parentAgentId: "00000000-0000-4000-8000-000000000001",
        tasks: [],
      },
    });
    expect(update.type).toBe("agent.background_tasks.update");
  });
});
```

Use a real UUID for `parentAgentId` if the schema requires `z.guid()`; match provider-subagent parent id typing exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/protocol/src/background-tasks-schema.test.ts --bail=1`  
Expected: FAIL (schemas/types missing)

- [ ] **Step 3: Implement schemas**

Add near provider-subagent schemas in `messages.ts`:

```ts
export const BackgroundTaskStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "stopped",
  "unknown",
]);

export const BackgroundTaskDescriptorPayloadSchema = z.object({
  taskId: z.string().min(1),
  parentAgentId: z.guid(),
  type: z.string().min(1),
  description: z.string(),
  command: z.string().nullable().optional(),
  status: BackgroundTaskStatusSchema,
  outputFile: z.string().nullable().optional(),
  lastSummary: z.string().nullable().optional(),
  updatedAt: z.string().min(1),
});
export type BackgroundTaskDescriptorPayload = z.infer<typeof BackgroundTaskDescriptorPayloadSchema>;
```

Wire inbound/outbound unions for all locked RPC names from the design. Keep error fields nullable optional consistent with neighboring RPCs.

In `ServerInfoStatusPayloadSchema.features` (or equivalent), add:

```ts
// COMPAT(backgroundTasks): added in v0.2.x, remove gate after 2027-02-01.
backgroundTasks: z.boolean().optional(),
```

- [ ] **Step 4: Run test + protocol typecheck**

Run:

```bash
npx vitest run packages/protocol/src/background-tasks-schema.test.ts --bail=1
npm run typecheck -w @getpaseo/protocol
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/messages.ts packages/protocol/src/background-tasks-schema.test.ts packages/protocol/src/generated || true
git commit -m "feat(protocol): add background tasks RPC schemas and feature flag"
```

---

### Task 2: Server live-set store (shell filter + replace)

**Files:**

- Create: `packages/server/src/server/agent/background-tasks/store.ts`
- Create: `packages/server/src/server/agent/background-tasks/store.test.ts`

**Interfaces:**

- Consumes: descriptor field names from Task 1
- Produces:
  - `class BackgroundTaskStore`
  - `replaceLiveSet(parentAgentId, tasks: Array<{ taskId; type; description }>, nowIso): BackgroundTaskDescriptor[]` — shell-only, status `running` for members, drops non-members
  - `enrich(parentAgentId, taskId, patch): BackgroundTaskDescriptor | null`
  - `list(parentAgentId): BackgroundTaskDescriptor[]`
  - `get(parentAgentId, taskId): BackgroundTaskDescriptor | null`
  - `deleteParent(parentAgentId): void`
  - `isShellTaskType(type: string): boolean` export for tests

- [ ] **Step 1: Write failing store tests**

```ts
import { describe, expect, it } from "vitest";
import { BackgroundTaskStore, isShellTaskType } from "./store.js";

const PARENT = "00000000-0000-4000-8000-000000000001";

describe("BackgroundTaskStore", () => {
  it("keeps only shell tasks on replace", () => {
    const store = new BackgroundTaskStore();
    const listed = store.replaceLiveSet(
      PARENT,
      [
        { taskId: "s1", type: "shell", description: "npm run dev" },
        { taskId: "a1", type: "subagent", description: "Explore" },
      ],
      "2026-08-01T00:00:00.000Z",
    );
    expect(listed.map((t) => t.taskId)).toEqual(["s1"]);
    expect(isShellTaskType("shell")).toBe(true);
    expect(isShellTaskType("subagent")).toBe(false);
  });

  it("replace drops tasks no longer present", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "one" }],
      "2026-08-01T00:00:00.000Z",
    );
    store.replaceLiveSet(PARENT, [], "2026-08-01T00:01:00.000Z");
    expect(store.list(PARENT)).toEqual([]);
  });

  it("enrich updates command and outputFile without inventing tasks", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "dev" }],
      "2026-08-01T00:00:00.000Z",
    );
    const updated = store.enrich(PARENT, "s1", {
      command: "npm run dev",
      outputFile: "/tmp/out.txt",
      updatedAt: "2026-08-01T00:00:05.000Z",
    });
    expect(updated?.command).toBe("npm run dev");
    expect(store.enrich(PARENT, "missing", { command: "x" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/agent/background-tasks/store.test.ts --bail=1`  
Expected: FAIL module not found

- [ ] **Step 3: Implement store**

```ts
export function isShellTaskType(type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return normalized === "shell" || normalized === "bash" || normalized === "local_bash";
}

export interface BackgroundTaskDescriptor {
  taskId: string;
  parentAgentId: string;
  type: string;
  description: string;
  command: string | null;
  status: "running" | "completed" | "failed" | "stopped" | "unknown";
  outputFile: string | null;
  lastSummary: string | null;
  updatedAt: string;
}
```

Key: `parentAgentId\0taskId`. On replace: build next map from shell tasks only; preserve command/outputFile/lastSummary from previous descriptor when same taskId; set status `running` for live members; return sorted stable list (by taskId).

- [ ] **Step 4: Run tests**

Run: `npx vitest run packages/server/src/server/agent/background-tasks/store.test.ts --bail=1`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/background-tasks
git commit -m "feat(server): add shell-filtered background task live set store"
```

---

### Task 3: Claude adapter maps SDK background-task events

**Files:**

- Create: `packages/server/src/server/agent/providers/claude/background-tasks.ts`
- Create: `packages/server/src/server/agent/providers/claude/background-tasks.test.ts`
- Modify: `packages/server/src/server/agent/providers/claude/agent.ts` (system message dispatch + Bash tool_result enrichment + expose list/stop/output helpers)
- Modify: `packages/server/src/server/agent/agent-sdk-types.ts` only if session surface needs new methods

**Interfaces:**

- Consumes: `BackgroundTaskStore` from Task 2; SDK message subtypes
- Produces pure mappers + agent methods:
  - `applyClaudeBackgroundSystemMessage(store, parentAgentId, message, nowIso): { changed: boolean; tasks: BackgroundTaskDescriptor[] }`
  - `correlateBashBackgroundTaskId(store, parentAgentId, backgroundTaskId, command, nowIso)`
  - On Claude session: `listBackgroundTasks()`, `stopBackgroundTask(taskId)`, `readBackgroundTaskOutput({ taskId, cursor, maxBytes })`

- [ ] **Step 1: Write failing mapper tests**

```ts
import { describe, expect, it } from "vitest";
import { BackgroundTaskStore } from "../../background-tasks/store.js";
import { applyClaudeBackgroundSystemMessage } from "./background-tasks.js";

const PARENT = "00000000-0000-4000-8000-000000000001";

describe("applyClaudeBackgroundSystemMessage", () => {
  it("replaces live set from background_tasks_changed", () => {
    const store = new BackgroundTaskStore();
    const result = applyClaudeBackgroundSystemMessage(
      store,
      PARENT,
      {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: [
          { task_id: "s1", task_type: "shell", description: "npm run dev" },
          { task_id: "x1", task_type: "subagent", description: "Explore" },
        ],
      },
      "2026-08-01T00:00:00.000Z",
    );
    expect(result.changed).toBe(true);
    expect(result.tasks.map((t) => t.taskId)).toEqual(["s1"]);
  });

  it("enriches status from task_notification stopped", () => {
    const store = new BackgroundTaskStore();
    store.replaceLiveSet(
      PARENT,
      [{ taskId: "s1", type: "shell", description: "npm run dev" }],
      "2026-08-01T00:00:00.000Z",
    );
    applyClaudeBackgroundSystemMessage(
      store,
      PARENT,
      {
        type: "system",
        subtype: "task_notification",
        task_id: "s1",
        status: "stopped",
        summary: "stopped",
        output_file: "/tmp/s1.log",
      },
      "2026-08-01T00:00:01.000Z",
    );
    // After notification, either enrich then next replace removes, or mark stopped until replace.
    // Spec: membership level is source of truth; notification enriches fields.
    expect(store.get(PARENT, "s1")?.outputFile).toBe("/tmp/s1.log");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/server/src/server/agent/providers/claude/background-tasks.test.ts --bail=1`  
Expected: FAIL

- [ ] **Step 3: Implement mapper + wire Claude agent**

In `background-tasks.ts`, handle:

| subtype                    | action                                                                |
| -------------------------- | --------------------------------------------------------------------- |
| `background_tasks_changed` | `replaceLiveSet` from `tasks[]`                                       |
| `task_started`             | if shell type present, ensure/enrich description                      |
| `task_progress`            | enrich `lastSummary` / description                                    |
| `task_updated`             | enrich status/description from patch                                  |
| `task_notification`        | enrich status + `outputFile` + summary (do not invent non-shell rows) |

In `claude/agent.ts` system dispatch (near existing `task_notification` / `task_progress` branches), call the mapper and emit a manager-level event when `changed` (pattern after provider_subagent updates). On Bash tool_result with `backgroundTaskId`, call correlate helper to set `command`.

Implement `stopBackgroundTask` by calling SDK `query.stopTask(taskId)` (or equivalent session handle). Implement `readBackgroundTaskOutput` by reading file from `outputFile` when present: support `cursor` byte offset and `maxBytes` (default 64_000), return `{ text, nextCursor, eof }`. Missing file → empty text + structured non-fatal error string.

Reset store on session/process restart paths already used for Claude restarts.

- [ ] **Step 4: Run tests**

Run:

```bash
npx vitest run packages/server/src/server/agent/providers/claude/background-tasks.test.ts --bail=1
npx vitest run packages/server/src/server/agent/background-tasks/store.test.ts --bail=1
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/providers/claude/background-tasks.ts \
  packages/server/src/server/agent/providers/claude/background-tasks.test.ts \
  packages/server/src/server/agent/providers/claude/agent.ts
git commit -m "feat(server): map Claude background shell tasks into live set"
```

---

### Task 4: Agent manager + session RPCs + feature advertise

**Files:**

- Modify: `packages/server/src/server/agent/agent-manager.ts`
- Modify: `packages/server/src/server/session.ts`
- Modify: `packages/server/src/server/websocket-server.ts` (features.backgroundTasks: true)
- Create: `packages/server/src/server/agent/background-tasks/session-handlers.test.ts` (or extend an existing session test harness if cheaper)

**Interfaces:**

- Produces agent-manager methods:
  - `listBackgroundTasks(parentAgentId)`
  - `stopBackgroundTask(parentAgentId, taskId)`
  - `getBackgroundTaskOutput(...)`
  - `subscribeBackgroundTaskOutput(session, parentAgentId, taskId)` / `unsubscribe...`
- Session handlers for all Task 1 RPCs
- Push `agent.background_tasks.update` when live set changes (to clients that care; no need for client cap if always safe)

- [ ] **Step 1: Write failing handler/unit test**

Prefer a focused unit test on agent-manager orchestration with a fake Claude session, or session handler test using existing fake host patterns. Minimal assertion:

```ts
it("lists shell tasks for parent agent", async () => {
  // arrange agent manager with store preloaded via test hook or replaceLiveSet exposure
  expect(manager.listBackgroundTasks(PARENT).map((t) => t.taskId)).toEqual(["s1"]);
});
```

If injecting store is hard, test pure session message routing with a stubbed `agentManager`.

- [ ] **Step 2: Run test to verify it fails**

Run targeted vitest file. Expected: FAIL

- [ ] **Step 3: Implement manager + session + feature flag**

Follow `listProviderSubagents` / `handleProviderSubagentListRequest` patterns:

```ts
// session.ts
case "agent.background_tasks.list.request":
  return this.handleBackgroundTasksListRequest(msg);
case "agent.background_tasks.stop.request":
  return this.handleBackgroundTasksStopRequest(msg);
// ... output get/subscribe/unsubscribe
```

Stop path: resolve agent → Claude session → `stopBackgroundTask`; return `{ ok: true }` or error string.

Output subscribe: register `(sessionId, parentAgentId, taskId)` in a small subscription map; interval (e.g. 1s) or file mtime poll only while subscribed; send `agent.background_tasks.output.update` with capped deltas; clear on unsubscribe/session close/task gone.

Advertise:

```ts
// websocket-server.ts features
// COMPAT(backgroundTasks): added in v0.2.x, remove gate after 2027-02-01.
backgroundTasks: true,
```

- [ ] **Step 4: Run tests + server typecheck**

```bash
npx vitest run packages/server/src/server/agent/background-tasks --bail=1
npm run typecheck -w @getpaseo/server
```

Expected: PASS (rebuild protocol/client first if needed: `npm run build:client`)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/agent/agent-manager.ts \
  packages/server/src/server/session.ts \
  packages/server/src/server/websocket-server.ts \
  packages/server/src/server/agent/background-tasks
git commit -m "feat(server): expose background tasks list, stop, and focus-gated output RPCs"
```

---

### Task 5: Client daemon methods

**Files:**

- Modify: `packages/client/src/daemon-client.ts`
- Test: add/extend a small client test only if the package already unit-tests RPC helpers; otherwise rely on typecheck + later app tests

**Interfaces:**

- Produces:
  - `listBackgroundTasks(parentAgentId)`
  - `stopBackgroundTask(parentAgentId, taskId)`
  - `getBackgroundTaskOutput(parentAgentId, taskId, { cursor?, maxBytes? })`
  - `subscribeBackgroundTaskOutput(parentAgentId, taskId)`
  - `unsubscribeBackgroundTaskOutput(parentAgentId, taskId)`

- [ ] **Step 1: Implement methods mirroring `listProviderSubagents`**

```ts
async listBackgroundTasks(parentAgentId: string, options: { requestId?: string; timeout?: number } = {}) {
  const requestId = this.createRequestId(options.requestId);
  const message = SessionInboundMessageSchema.parse({
    type: "agent.background_tasks.list.request",
    parentAgentId,
    requestId,
  });
  // sendRequest + select list.response by requestId
}
```

Same pattern for stop/output/subscribe/unsubscribe.

- [ ] **Step 2: Typecheck client**

```bash
npm run build:client
npm run typecheck -w @getpaseo/client
```

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/daemon-client.ts
git commit -m "feat(client): add background tasks daemon RPCs"
```

---

### Task 6: App store + session push wiring

**Files:**

- Create: `packages/app/src/background-tasks/store.ts`
- Create: `packages/app/src/background-tasks/store.test.ts`
- Create: `packages/app/src/background-tasks/select.ts` (+ test if non-trivial)
- Modify: `packages/app/src/contexts/session-context.tsx` (subscribe to `agent.background_tasks.update`)

**Interfaces:**

- Produces:
  - `useBackgroundTaskStore` with `replaceList(serverId, parentAgentId, tasks)`, `applyUpdate(...)`
  - `backgroundTaskKey(serverId, parentAgentId, taskId)`
  - `refreshBackgroundTasks(client, serverId, parentAgentId)`
  - `useBackgroundTasksForParent({ serverId, parentAgentId })` → `BackgroundTaskDescriptorPayload[]`

- [ ] **Step 1: Write failing store test**

```ts
import { describe, expect, it } from "vitest";
import { useBackgroundTaskStore } from "./store";

describe("background task store", () => {
  it("replaces tasks for a parent agent", () => {
    useBackgroundTaskStore.getState().replaceList("srv", "agent-1", [
      {
        taskId: "s1",
        parentAgentId: "agent-1",
        type: "shell",
        description: "dev",
        command: "npm run dev",
        status: "running",
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
    const all = [...useBackgroundTaskStore.getState().tasks.values()];
    expect(all).toHaveLength(1);
    expect(all[0]?.taskId).toBe("s1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/src/background-tasks/store.test.ts --bail=1`  
Expected: FAIL

- [ ] **Step 3: Implement store + session listener**

Mirror `provider-store.ts` replaceList semantics (delete previous prefix keys, insert new). In `session-context.tsx`, next to provider subagent update subscription:

```ts
const unsubBackgroundTasks = client.on("agent.background_tasks.update", (message) => {
  if (message.type !== "agent.background_tasks.update") return;
  useBackgroundTaskStore.getState().applyUpdate(serverId, message.payload);
});
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run packages/app/src/background-tasks/store.test.ts --bail=1
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/background-tasks packages/app/src/contexts/session-context.tsx
git commit -m "feat(app): store live background tasks from daemon updates"
```

---

### Task 7: Background Tasks track UI + Stop icon + agent-panel mount

**Files:**

- Create: `packages/app/src/background-tasks/track.tsx`
- Create: `packages/app/src/background-tasks/track-presentation.ts` (+ test optional)
- Create: `packages/app/src/background-tasks/use-stop-background-task.ts`
- Create: `packages/app/src/background-tasks/track.test.tsx` (jsdom, render null when empty)
- Modify: `packages/app/src/panels/agent-panel.tsx` (mount under SubagentsTrack)
- Modify: i18n resources (`en` required; other locales as repo convention requires)

**Interfaces:**

- Consumes: `useBackgroundTasksForParent`, `refreshBackgroundTasks`, client stop RPC
- Produces: `BackgroundTasksTrack` props:
  - `rows`, `onOpenTask(taskId)`, `onStopTask(taskId)`

- [ ] **Step 1: Write failing empty-state test**

```tsx
/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { BackgroundTasksTrack } from "./track";

describe("BackgroundTasksTrack", () => {
  it("renders nothing when there are no rows", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<BackgroundTasksTrack rows={[]} onOpenTask={vi.fn()} onStopTask={vi.fn()} />);
    });
    expect(container.querySelector("[data-testid='background-tasks-track']")).toBeNull();
    act(() => root.unmount());
    container.remove();
  });
});
```

Mock i18n/unistyles as neighboring track tests do if required.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/src/background-tasks/track.test.tsx --bail=1`  
Expected: FAIL

- [ ] **Step 3: Implement track by cloning SubagentsTrack patterns**

From `packages/app/src/subagents/track.tsx`:

- Same outer/surface/header/scroll structure
- Header label: `Background Tasks` / `Background Tasks (N)`
- Row label: `command ?? description`
- Row action: icon-only Stop (`Square` or `Octagon`/`CircleStop` from lucide — pick one consistent with destructive stop affordances; tooltip `Stop`)
- Hover visibility: `isNative || isCompact || hovered` (match subagents)
- `testID`s: `background-tasks-track`, `background-tasks-track-header`, `background-tasks-track-row-${id}`, `background-tasks-track-stop-${id}`

Wire `agent-panel.tsx`:

```tsx
<SubagentsTrack ... />
<BackgroundTasksTrack
  rows={backgroundTaskRows}
  onOpenTask={(taskId) => openTab({ kind: "background_task", parentAgentId: agentId, taskId })}
  onStopTask={handleStopBackgroundTask}
/>
<Composer ... />
```

Gate: only refresh/show when `serverInfo?.features?.backgroundTasks === true`.

Stop hook: call client, toast on failure, optimistic pending set optional.

Add i18n keys under something like `backgroundTasks.*`.

- [ ] **Step 4: Run tests + lint target**

```bash
npx vitest run packages/app/src/background-tasks --bail=1
npm run lint -- packages/app/src/background-tasks packages/app/src/panels/agent-panel.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/background-tasks packages/app/src/panels/agent-panel.tsx packages/app/src/i18n
git commit -m "feat(app): add Background Tasks track with icon-only Stop"
```

---

### Task 8: Workspace tab + detail panel + focus-gated live logs

**Files:**

- Modify: `packages/app/src/workspace-tabs/model.ts` (add tab kind)
- Modify: `packages/app/src/workspace-tabs/identity.ts` (+ tests if present)
- Modify: `packages/app/src/panels/register-panels.ts`
- Create: `packages/app/src/panels/background-task-panel.tsx`
- Create: `packages/app/src/background-tasks/use-background-task-output.ts` (+ test for focus gate)
- Modify: tab presentation/menu files if they switch on `kind` exhaustively (`workspace-tab-presentation.tsx`, `workspace-tab-menu.ts`, `workspace-screen.tsx`, layout actions normalize)

**Interfaces:**

- Tab target: `{ kind: "background_task"; parentAgentId: string; taskId: string }`
- Output hook: subscribe on focus true; unsubscribe on blur/unmount; append `output.update` chunks

- [ ] **Step 1: Write failing focus-gate unit test**

```ts
import { describe, expect, it } from "vitest";
import { shouldSubscribeToBackgroundTaskOutput } from "./use-background-task-output";

describe("background task output focus gate", () => {
  it("subscribes only when tab is focused and feature supported", () => {
    expect(shouldSubscribeToBackgroundTaskOutput({ supported: true, isPaneFocused: true })).toBe(
      true,
    );
    expect(shouldSubscribeToBackgroundTaskOutput({ supported: true, isPaneFocused: false })).toBe(
      false,
    );
    expect(shouldSubscribeToBackgroundTaskOutput({ supported: false, isPaneFocused: true })).toBe(
      false,
    );
  });
});
```

Export a pure helper from the hook module for testability.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/app/src/background-tasks/use-background-task-output --bail=1`  
Expected: FAIL

- [ ] **Step 3: Implement tab kind + panel**

1. Extend `WorkspaceTabTarget` union.
2. Update `buildDeterministicWorkspaceTabId` / equality / normalize switches (TypeScript will flag exhaustiveness).
3. Register panel like provider subagent:

```ts
export const backgroundTaskPanelRegistration: PanelRegistration<"background_task"> = {
  kind: "background_task",
  component: BackgroundTaskPanel,
  useDescriptor: useBackgroundTaskPanelDescriptor,
};
```

Panel contents:

- Header texts: command, status, description
- Log `ScrollView`/`Text` monospace using theme fonts
- Empty: i18n “No live log available”
- On focus: `subscribeBackgroundTaskOutput` + listen `agent.background_tasks.output.update` filtered by parent/task; on blur/unmount unsubscribe
- Initial `getBackgroundTaskOutput` once on open

No Stop button in panel.

- [ ] **Step 4: Run tests + app typecheck**

```bash
npx vitest run packages/app/src/background-tasks --bail=1
npm run typecheck -w @getpaseo/app
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/app/src/workspace-tabs packages/app/src/panels packages/app/src/background-tasks packages/app/src/stores
git commit -m "feat(app): open Background Task tabs with focus-gated live logs"
```

---

### Task 9: Glossary, polish, verification

**Files:**

- Modify: `docs/glossary.md` (Composer track bullet + Background Tasks term)
- Fix any remaining exhaustive switches found by typecheck
- Targeted tests only

- [ ] **Step 1: Update glossary**

Add:

```md
- **Background Tasks** — Live long-running shell processes started by an agent provider (v1: Claude Code), shown in the **Background Tasks track** under Subagents. UI: "Background Tasks". Don't confuse with: Schedule/Heartbeat (Paseo cron), Subagent, or internal file/git watchers.
```

Update **Composer track** line to mention Background Tasks track.

- [ ] **Step 2: Full verification pass**

```bash
npx vitest run packages/protocol/src/background-tasks-schema.test.ts --bail=1
npx vitest run packages/server/src/server/agent/background-tasks --bail=1
npx vitest run packages/server/src/server/agent/providers/claude/background-tasks.test.ts --bail=1
npx vitest run packages/app/src/background-tasks --bail=1
npm run typecheck
npm run lint
npm run format
```

- [ ] **Step 3: Commit**

```bash
git add docs/glossary.md
git commit -m "docs: glossary entry for Background Tasks track"
```

- [ ] **Step 4: Manual smoke (if daemon available)**

1. Claude agent: ask it to `run_in_background` something like `sleep 30` or `npm run dev`.
2. Confirm track appears under Subagents with command label.
3. Stop icon stops task; row disappears after membership update.
4. Open tab; logs update only while tab focused; switching away stops refresh.

---

## Spec coverage checklist

| Spec requirement                   | Task      |
| ---------------------------------- | --------- |
| Track under Subagents, hide empty  | 7         |
| Shell-only live list               | 2, 3      |
| `background_tasks_changed` replace | 3         |
| Feature flag                       | 1, 4      |
| List/update/stop/output RPCs       | 1, 4, 5   |
| Icon-only Stop on track only       | 7         |
| Tab open like subagent             | 7, 8      |
| Focus-only log polling             | 4, 8      |
| Claude-only v1                     | 3, 7 gate |
| Glossary                           | 9         |
| Protocol compatibility             | 1         |

## Execution notes

- Prefer implementing Tasks 1→9 in order; UI before protocol will thrash types.
- If Claude SDK message field names differ slightly at runtime, keep mappers tolerant (`task_id` vs nested) with tests for both.
- Do not implement PTY terminals or non-shell task types in this plan.
