# Lock / read-only mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user monitor agents on a device without accidental taps sending prompts, approving tools, forking, or stopping work.

**Architecture:** Client-only preference. A small persisted store exposes `isInteractionLocked`. Dangerous surfaces read the flag (or a React context) and no-op / hide mutating controls. Agent stream already has a `readOnly` path that disables fork — extend that pattern. Stream rendering stays live.

**Tech Stack:** Zustand + AsyncStorage preference, React context optional, existing agent stream `readOnly` prop.

**Spec:** [docs/superpowers/specs/2026-08-01-p0-p1-release-train-design.md](../specs/2026-08-01-p0-p1-release-train-design.md) §2

## Global Constraints

- Device-local only — not daemon-enforced.
- Does **not** require `uiState` or host update.
- Allow navigation between workspaces/tabs while locked (monitoring remains useful).
- Block: send, queue, voice start, mode/model changes, rewind, fork, tool approvals, archive/stop/kill without unlock.
- Unlock via explicit banner control (single tap / button).
- No OS kiosk / Android screen lock.
- Targeted tests only; typecheck/lint/format before commit.

## File map

| Path                                                     | Responsibility                   |
| -------------------------------------------------------- | -------------------------------- |
| `packages/app/src/stores/interaction-lock-store.ts`      | Persisted lock preference        |
| `packages/app/src/stores/interaction-lock-store.test.ts` | Store tests                      |
| `packages/app/src/interaction-lock/*`                    | Context/hook + banner UI         |
| `packages/app/src/composer/*`                            | Gate send/queue/voice/controls   |
| `packages/app/src/agent-stream/view.tsx`                 | Force `readOnly` when locked     |
| `packages/app/src/app/_layout.tsx` or workspace chrome   | Mount lock banner + toggle entry |
| i18n `en.ts` (+ other locales if required by tests)      | Copy                             |

---

### Task 1: Interaction lock store

**Files:**

- Create: `packages/app/src/stores/interaction-lock-store.ts`
- Create: `packages/app/src/stores/interaction-lock-store.test.ts`

**Interfaces:**

- Produces:
  - `useInteractionLockStore` with `{ locked: boolean; setLocked(locked: boolean): void; toggle(): void }`
  - Persist name: `@paseo:interaction-lock`

- [ ] **Step 1: Failing test**

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useInteractionLockStore } from "./interaction-lock-store";

describe("interaction lock store", () => {
  beforeEach(() => {
    useInteractionLockStore.setState({ locked: false });
  });

  it("defaults unlocked", () => {
    expect(useInteractionLockStore.getState().locked).toBe(false);
  });

  it("toggles lock", () => {
    useInteractionLockStore.getState().setLocked(true);
    expect(useInteractionLockStore.getState().locked).toBe(true);
    useInteractionLockStore.getState().toggle();
    expect(useInteractionLockStore.getState().locked).toBe(false);
  });
});
```

- [ ] **Step 2: Run — FAIL**

```bash
npx vitest run packages/app/src/stores/interaction-lock-store.test.ts --bail=1
```

- [ ] **Step 3: Implement store**

```ts
import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface InteractionLockState {
  locked: boolean;
  setLocked: (locked: boolean) => void;
  toggle: () => void;
}

export const useInteractionLockStore = create<InteractionLockState>()(
  persist(
    (set, get) => ({
      locked: false,
      setLocked: (locked) => set({ locked }),
      toggle: () => set({ locked: !get().locked }),
    }),
    {
      name: "@paseo:interaction-lock",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ locked: state.locked }),
    },
  ),
);
```

- [ ] **Step 4: Run — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(app): add interaction lock preference store"
```

---

### Task 2: Lock banner + entry point

**Files:**

- Create: `packages/app/src/interaction-lock/banner.tsx`
- Create: `packages/app/src/interaction-lock/use-interaction-locked.ts`
- Modify: workspace layout / agent screen chrome (find the agent screen shell that already hosts attention banners — likely workspace layout or agent screen)
- Modify: i18n `packages/app/src/i18n/resources/en.ts`

**Interfaces:**

- `useInteractionLocked(): boolean` thin selector
- Banner visible only when locked; primary action “Unlock”

- [ ] **Step 1: Add English strings**

```ts
interactionLock: {
  banner: "Read-only · monitoring",
  unlock: "Unlock",
  lock: "Lock screen",
  lockedA11y: "Interaction lock on. Unlock to interact.",
}
```

If `packages/app/src/i18n/resources.test.ts` requires parity across locales, add matching keys to all locale files (copy English temporarily if needed to satisfy tests).

- [ ] **Step 2: Implement banner component** (quiet chip/bar, not modal)

- [ ] **Step 3: Mount in agent/workspace chrome above composer**

- [ ] **Step 4: Add toggle entry** in an existing overflow/menu (workspace menu or agent kebab). Label: “Lock screen” / “Unlock”.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(app): add read-only lock banner and menu toggle"
```

---

### Task 3: Gate composer + agent stream

**Files:**

- Modify: `packages/app/src/composer/index.tsx` (and/or input)
- Modify: `packages/app/src/agent-stream/view.tsx`
- Modify: tool approval UI entry if separate from stream
- Test: small unit/component tests for gate helpers

**Interfaces:**

- Produces: `resolveComposerInteractionPolicy({ locked, ... })` pure helper if useful

- [ ] **Step 1: Write pure helper tests**

```ts
expect(resolveComposerInteractionPolicy({ locked: true, isAgentRunning: true })).toEqual({
  canEdit: false,
  canSend: false,
  canQueue: false,
  canChangeControls: false,
  canStartVoice: false,
});
```

- [ ] **Step 2: Implement helper + wire composer**

When locked:

- disable TextInput / treat as non-editable
- disable send & queue buttons
- hide or disable agent controls (mode/model/thinking)
- do not start voice

- [ ] **Step 3: Agent stream**

In `view.tsx`, when locked, pass `readOnly: true` into the same paths that already strip `onForkAssistantTurn` (see existing `readOnly ? undefined : handleForkAssistantTurn`).

Ensure rewind menu / tool approval actions are also disabled when locked.

- [ ] **Step 4: Stop/archive/kill**

On destructive agent actions while locked: either hide controls or require unlock first (prefer hide/disable with toast “Unlock to control this agent”).

- [ ] **Step 5: Run targeted tests + commit**

```bash
npx vitest run packages/app/src/stores/interaction-lock-store.test.ts packages/app/src/interaction-lock --bail=1
git commit -m "feat(app): enforce interaction lock on composer and stream"
```

---

### Task 4: Verify navigation still works + typecheck

- [ ] **Step 1: Manually reason through / smoke in dev if available** — sidebar navigation and tab switching must work while locked.

- [ ] **Step 2:**

```bash
npm run typecheck
npm run lint
npm run format
```

- [ ] **Step 3: Commit any fixups**

## Manual verification

1. Start a long-running agent.
2. Enable Lock screen on mobile.
3. Mash the composer, send, fork, rewind, approvals — no mutations.
4. Stream still updates.
5. Switch workspaces/tabs still works.
6. Unlock restores full control.
7. Relaunch app — lock preference restored.
