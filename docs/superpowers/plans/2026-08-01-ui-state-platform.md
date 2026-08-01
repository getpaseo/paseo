# Daemon UI-state platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist composer drafts and review drafts on the daemon so every client on a host shares the same text/comments across devices.

**Architecture:** New `$PASEO_HOME/ui-state/{composer,review}/` JSON store with atomic writes, dotted `ui_state.*` RPCs, and `ui_state.updated` push events. Clients treat zustand as cache when `server_info.features.uiState` is true; otherwise keep AsyncStorage-only behavior.

**Tech Stack:** Zod wire schemas in `@getpaseo/protocol`, Node atomic JSON store in `@getpaseo/server`, DaemonClient methods, app draft/review stores.

**Spec:** [docs/superpowers/specs/2026-08-01-p0-p1-release-train-design.md](../specs/2026-08-01-p0-p1-release-train-design.md) §1

## Global Constraints

- Protocol stays backward-compatible: new fields optional; new RPCs feature-gated.
- Feature flag: `server_info.features.uiState` with `// COMPAT(uiState): added in v0.2.916, drop gate ~2027-02-01`.
- No degraded multi-RPC fan-out on old daemons — single gate, local-only path.
- Wire keys never include client `serverId`.
- Composer MVP: **text first**; attachment metadata may sync; blob portability is Phase B.
- LWW by ISO `updatedAt`.
- Run only targeted vitest files; never full suite.
- After changes: `npm run typecheck`, `npm run lint`, `npm run format` before commit.

## File map

| Path                                                                | Responsibility                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/protocol/src/ui-state/` (new) or schemas in `messages.ts` | Wire schemas + types                                  |
| `packages/protocol/src/messages.ts`                                 | Register inbound/outbound unions + `features.uiState` |
| `packages/server/src/server/ui-state/store.ts`                      | Atomic file store                                     |
| `packages/server/src/server/ui-state/store.test.ts`                 | Store unit tests                                      |
| `packages/server/src/server/ui-state/keys.ts`                       | Key sanitize + validation                             |
| `packages/server/src/server/session.ts`                             | RPC handlers + broadcast                              |
| `packages/server/src/server/websocket-server.ts`                    | Feature flag true                                     |
| `packages/server/src/server/bootstrap.ts`                           | Construct store, inject into sessions                 |
| `packages/client/src/daemon-client.ts`                              | Client RPC helpers                                    |
| `packages/app/src/stores/draft-store/*`                             | Host-backed save/hydrate when feature on              |
| `packages/app/src/review/store.ts`                                  | Host-backed review comments                           |
| `packages/app/src/ui-state/*` (new)                                 | Key mapping client↔wire, sync helpers                 |
| `docs/data-model.md`                                                | Document `ui-state/` layout                           |

---

### Task 1: Protocol schemas + feature flag

**Files:**

- Create: `packages/protocol/src/ui-state/schemas.ts` (preferred) **or** add near other schemas in `packages/protocol/src/messages.ts` if package convention forbids new folder without export wiring
- Modify: `packages/protocol/src/messages.ts` (unions + `features.uiState`)
- Test: `packages/protocol/src/ui-state/schemas.test.ts` (or `messages.ui-state.test.ts`)

**Interfaces:**

- Produces:
  - `UiStateNamespaceSchema = z.enum(["composer", "review"])`
  - `UiStateComposerRecordSchema` with `text`, optional `attachments`, `lifecycle`, `updatedAt`
  - `UiStateReviewRecordSchema` with `comments[]`, `updatedAt`
  - Request/response types: `ui_state.get|upsert|clear|list` `.request`/`.response`
  - Push: `ui_state.updated` with `{ namespace, key, record: record|null, updatedAt }`

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import {
  UiStateGetRequestMessageSchema,
  UiStateUpsertRequestMessageSchema,
  UiStateUpdatedMessageSchema,
} from "../messages.js"; // or ui-state/schemas

describe("ui_state wire", () => {
  it("parses get request", () => {
    const parsed = UiStateGetRequestMessageSchema.parse({
      type: "ui_state.get.request",
      requestId: "r1",
      namespace: "composer",
      key: "agent:agt_1",
    });
    expect(parsed.key).toBe("agent:agt_1");
  });

  it("rejects empty key", () => {
    expect(() =>
      UiStateUpsertRequestMessageSchema.parse({
        type: "ui_state.upsert.request",
        requestId: "r1",
        namespace: "composer",
        key: "",
        record: { text: "hi", updatedAt: "2026-08-01T00:00:00.000Z" },
      }),
    ).toThrow();
  });

  it("parses updated push with null record (cleared)", () => {
    const parsed = UiStateUpdatedMessageSchema.parse({
      type: "ui_state.updated",
      namespace: "review",
      key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      record: null,
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parsed.record).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect FAIL (schemas missing)**

```bash
npx vitest run packages/protocol/src/ui-state/schemas.test.ts --bail=1
```

- [ ] **Step 3: Implement schemas**

Minimal shapes:

```ts
export const UiStateNamespaceSchema = z.enum(["composer", "review"]);

export const UiStateComposerRecordSchema = z.object({
  text: z.string().optional().default(""),
  // Keep attachment metadata structural; do not require blob resolvability.
  attachments: z.array(z.unknown()).optional(),
  lifecycle: z.enum(["active", "abandoned", "sent"]).optional(),
  updatedAt: z.string().min(1),
});

export const UiStateReviewCommentSchema = z.object({
  id: z.string().min(1),
  filePath: z.string().min(1),
  side: z.enum(["old", "new"]),
  lineNumber: z.number().int().nonnegative(),
  body: z.string(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

export const UiStateReviewRecordSchema = z.object({
  comments: z.array(UiStateReviewCommentSchema).optional().default([]),
  updatedAt: z.string().min(1),
});
```

Register all request/response/push schemas into `SessionInboundMessageSchema` / outbound unions exactly like `agent.fork_context.*`.

Add to `server_info.features`:

```ts
// COMPAT(uiState): added in v0.2.916, drop gate after 2027-02-01.
uiState: z.boolean().optional(),
```

- [ ] **Step 4: Run tests — expect PASS**

```bash
npx vitest run packages/protocol/src/ui-state/schemas.test.ts --bail=1
```

- [ ] **Step 5: Commit**

```bash
git add packages/protocol
git commit -m "feat(protocol): add ui_state RPCs and feature flag"
```

---

### Task 2: Server store

**Files:**

- Create: `packages/server/src/server/ui-state/keys.ts`
- Create: `packages/server/src/server/ui-state/store.ts`
- Create: `packages/server/src/server/ui-state/store.test.ts`

**Interfaces:**

- Produces:
  - `class UiStateStore { get; upsert; clear; list; }`
  - `sanitizeUiStateKey(key: string): string` for filesystem safety
  - LWW: upsert ignores incoming if stored `updatedAt` is newer

- [ ] **Step 1: Failing store tests**

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UiStateStore } from "./store.js";

describe("UiStateStore", () => {
  let home: string;
  let store: UiStateStore;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "paseo-ui-state-"));
    store = new UiStateStore(home);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("upserts and gets composer text", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "hello", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    const got = await store.get({ namespace: "composer", key: "agent:agt_1" });
    expect(got).toMatchObject({ text: "hello" });
  });

  it("LWW rejects older upsert", async () => {
    await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "new", updatedAt: "2026-08-01T01:00:00.000Z" },
    });
    const result = await store.upsert({
      namespace: "composer",
      key: "agent:agt_1",
      record: { text: "old", updatedAt: "2026-08-01T00:00:00.000Z" },
    });
    expect(result.applied).toBe(false);
    expect((await store.get({ namespace: "composer", key: "agent:agt_1" }))?.text).toBe("new");
  });

  it("clear removes record", async () => {
    await store.upsert({
      namespace: "review",
      key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      record: {
        comments: [],
        updatedAt: "2026-08-01T00:00:00.000Z",
      },
    });
    await store.clear({
      namespace: "review",
      key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      updatedAt: "2026-08-01T00:00:01.000Z",
    });
    expect(
      await store.get({
        namespace: "review",
        key: "review:workspace=ws1:mode=working:base=main:ignoreWhitespace=false",
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
npx vitest run packages/server/src/server/ui-state/store.test.ts --bail=1
```

- [ ] **Step 3: Implement store**

```ts
// packages/server/src/server/ui-state/store.ts
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonFileAtomic } from "../atomic-file.js";

export class UiStateStore {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly paseoHome: string) {}

  private dir(namespace: "composer" | "review"): string {
    return join(this.paseoHome, "ui-state", namespace);
  }

  private filePath(namespace: "composer" | "review", key: string): string {
    return join(this.dir(namespace), `${sanitizeUiStateKey(key)}.json`);
  }

  // serialize all mutations through this.queue like TaskStore
  // get/upsert/clear/list as designed
}
```

Use `writeJsonFileAtomic`. Sanitize keys (replace path separators). Reject keys that sanitize to empty.

- [ ] **Step 4: Run — PASS**

```bash
npx vitest run packages/server/src/server/ui-state/store.test.ts --bail=1
```

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/server/ui-state
git commit -m "feat(server): add UiStateStore for composer and review drafts"
```

---

### Task 3: Session RPCs + feature flag + bootstrap

**Files:**

- Modify: `packages/server/src/server/websocket-server.ts` (`uiState: true`)
- Modify: `packages/server/src/server/bootstrap.ts` (construct store)
- Modify: `packages/server/src/server/session.ts` (handlers + broadcast)
- Test: `packages/server/src/server/ui-state/session.ui-state.test.ts` (or extend existing session test harness)

**Interfaces:**

- Consumes: `UiStateStore`
- Produces: handlers for `ui_state.get|upsert|clear|list.request`; broadcast `ui_state.updated` to other sessions on same daemon

- [ ] **Step 1: Write failing integration-style test** using existing session test helpers if present; otherwise unit-test handler functions extracted for purity.

Cover:

1. get missing → `record: null`
2. upsert → get returns record
3. upsert broadcasts updated event (spy on send)
4. older upsert → `applied: false`, no broadcast (or broadcast only when applied)

- [ ] **Step 2: Run — FAIL**

- [ ] **Step 3: Wire handlers**

Pattern (mirror `agent.fork_context.request` around `session.ts`):

```ts
case "ui_state.get.request":
  await this.handleUiStateGet(msg);
  break;
```

Broadcast:

```ts
this.broadcastToOthers({
  type: "ui_state.updated",
  namespace,
  key,
  record,
  updatedAt,
});
```

Set `features.uiState: true` next to `taskBacklog: true` in `websocket-server.ts`.

- [ ] **Step 4: Run targeted tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(server): handle ui_state RPCs and advertise uiState feature"
```

---

### Task 4: DaemonClient methods

**Files:**

- Modify: `packages/client/src/daemon-client.ts`
- Test: `packages/client/src/index.test.ts` or new `ui-state-client.test.ts` if request helpers are unit-testable

**Interfaces:**

- Produces:
  - `getUiState({ namespace, key })`
  - `upsertUiState({ namespace, key, record })`
  - `clearUiState({ namespace, key, updatedAt })`
  - `listUiState({ namespace, keyPrefix? })` optional

- [ ] **Step 1–4:** Add methods following `buildAgentForkContext` request/response pairing.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(client): add ui_state RPC helpers"
```

---

### Task 5: Client key mapping + composer sync

**Files:**

- Create: `packages/app/src/ui-state/keys.ts` (+ test)
- Create: `packages/app/src/ui-state/use-host-ui-state.ts` (or integrate into draft-store)
- Modify: `packages/app/src/stores/draft-keys.ts` if needed
- Modify: `packages/app/src/stores/draft-store/index.ts`
- Modify: `packages/app/src/composer/draft/input-draft.ts`
- Test: `packages/app/src/ui-state/keys.test.ts`, draft store tests

**Interfaces:**

- Produces:
  - `toWireComposerKey(clientDraftKey: string): string | null` — strips `serverId` segment from `agent:{serverId}:{agentId}` / `draft:{serverId}:{draftId}`
  - `saveDraftInput` debounced host upsert when feature on
  - hydrate from host on mount when feature on (fallback local)

- [ ] **Step 1: Key mapping tests**

```ts
expect(toWireComposerKey("agent:srv1:agt_9")).toBe("agent:agt_9");
expect(toWireComposerKey("draft:srv1:draft_1")).toBe("draft:draft_1");
expect(toWireComposerKey("new-workspace")).toBe("new-workspace");
expect(toWireComposerKey("new-workspace:draft:draft_1")).toBe("new-workspace:draft:draft_1");
```

- [ ] **Step 2: Implement mapping + debounce helper (~300ms) for text upserts**

- [ ] **Step 3: Wire `useAgentInputDraft`**

On hydrate:

1. local hydrate (existing)
2. if `features.uiState` and online client: `getUiState` and if remote newer/missing local, apply into draft store

On `setText`/`clear`:

- always update local store (snappy UI)
- if feature on: schedule upsert / clear on host

Subscribe to `ui_state.updated` for namespace composer and apply LWW into draft store.

- [ ] **Step 4: Unit tests for mapping + LWW apply helper**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(app): sync composer drafts through host ui_state"
```

---

### Task 6: Review draft sync

**Files:**

- Modify: `packages/app/src/review/store.ts`
- Create: `packages/app/src/ui-state/review-keys.ts` (+ test)
- Modify: review surface mount to hydrate

**Interfaces:**

- `toWireReviewKey` from `buildReviewDraftKey` parts without server segment
- On add/update/delete comment: local store + host upsert full comments array
- On send review success: `clear` host + local

- [ ] **Step 1: Tests for wire key stability** matching `buildReviewDraftKey` minus server.

- [ ] **Step 2: Implement host sync in review store actions**

- [ ] **Step 3: Hydrate on review surface open**

- [ ] **Step 4: Run review + ui-state tests**

```bash
npx vitest run packages/app/src/review/store.test.ts packages/app/src/ui-state --bail=1
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(app): sync review drafts through host ui_state"
```

---

### Task 7: Docs + typecheck

**Files:**

- Modify: `docs/data-model.md` (directory layout + short ui-state section)
- Optionally note in `docs/architecture.md` if there is a persistence section

- [ ] **Step 1: Document layout**

```
$PASEO_HOME/ui-state/
  composer/{sanitized-key}.json
  review/{sanitized-key}.json
```

- [ ] **Step 2: typecheck/lint/format**

```bash
npm run build:client
npm run typecheck
npm run lint
npm run format
```

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: document ui-state daemon store"
```

---

## Manual verification

1. Desktop: type a long prompt on an agent; do not send.
2. Mobile (same host): open same agent → text present.
3. Edit on mobile → desktop updates within ~1s.
4. Send on one device → both clear.
5. Add review comment on desktop → visible on mobile.
6. Old daemon without feature: app still uses local drafts only.

## Phase B (same train only if cheap)

Host-resident attachment blobs under `$PASEO_HOME/ui-state/assets/`. Do not block ship on this.
