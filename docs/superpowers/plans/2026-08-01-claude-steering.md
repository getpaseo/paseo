# Claude steering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users redirect an **in-flight Claude turn** with new instructions without waiting for the turn to finish as a normal queued follow-up.

**Architecture:** Expose provider capability `supportsSteer`. For Claude, implement steer as **interrupt active turn + immediately submit the steer message** using existing `interruptActiveTurn` and prompt entrypoints (unless a cleaner SDK API exists — spike first). UI adds an explicit Steer action distinct from Queue. OMP keeps its existing `/steer` command path.

**Tech Stack:** Claude provider run-loop, protocol optional prompt flag or `agent.steer` RPC, composer toolbar/send menu.

**Spec:** [docs/superpowers/specs/2026-08-01-p0-p1-release-train-design.md](../specs/2026-08-01-p0-p1-release-train-design.md) §4

## Global Constraints

- Claude-first productization; OMP already has `/steer` — do not regress it.
- Queue remains the default send-while-running behavior unless user explicitly chooses Steer.
- Idle agent: Steer disabled or equivalent to normal send (prefer disabled + explanation).
- Interaction lock disables Steer.
- Capability-gated UI; no fake steer on providers that only queue.
- Protocol back-compat: optional fields only.
- Targeted tests; typecheck/lint/format before commit.

## Spike (before Task 1 implementation coding)

Read and note in the PR:

1. `packages/server/src/server/agent/providers/claude/agent.ts` — `interruptActiveTurn`, how queued messages are adopted after interrupt (see redesign tests / `sdk-behavior.real.e2e.test.ts` comments about pushing next message before interrupt).
2. Whether Agent SDK has a first-class steer API in the locked dependency version.

**Decision rule:**

- If interrupt + immediate next user message already matches desired UX → implement that and label UI “Steer (interrupts current turn)”.
- If SDK has explicit steer → prefer it.
- Document actual semantics in UI string; do not claim Claude Code TUI parity unless verified.

---

## File map

| Path                                                         | Responsibility                                                           |
| ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `packages/protocol/src/messages.ts` / agent capabilities     | `supportsSteer`, optional `steer` on prompt **or** `agent.steer.request` |
| `packages/server/src/server/agent/providers/claude/agent.ts` | Steer implementation                                                     |
| `packages/server/src/server/agent/agent-manager.ts`          | Pass-through API                                                         |
| `packages/server/src/server/session.ts`                      | Wire entry                                                               |
| `packages/client/src/daemon-client.ts`                       | Client API                                                               |
| `packages/app/src/composer/*`                                | Steer affordance                                                         |
| `packages/app/src/composer/input/labels.ts`                  | Copy                                                                     |
| i18n resources                                               | Strings                                                                  |

**Preferred wire shape (choose one in Task 1 after spike):**

**Option A — prompt flag (simpler if send path is unified):**

```ts
// existing prompt request gains:
steer: z.boolean().optional().default(false);
```

**Option B — dedicated RPC:**

```ts
{
  type: "agent.steer.request",
  requestId,
  agentId,
  message,
  attachments?: ...
}
```

Prefer **A** if `sendPromptToAgent` already centralizes running-agent behavior; else **B**.

---

### Task 1: Protocol + capability

**Files:** protocol messages + agent capability schemas + tests

- [ ] **Step 1: Add tests for `supportsSteer` default false and chosen wire field/RPC**

- [ ] **Step 2: Implement schemas + union registration**

```ts
// COMPAT(supportsSteer): added in v0.2.916
supportsSteer: z.boolean().optional().default(false);
```

If Option A:

```ts
// on prompt request payload
// COMPAT(promptSteer): added in v0.2.916
steer: z.boolean().optional().default(false);
```

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(protocol): add steer capability and wire field"
```

---

### Task 2: Claude provider steer behavior

**Files:**

- Modify: `packages/server/src/server/agent/providers/claude/agent.ts`
- Test: `packages/server/src/server/agent/providers/claude/agent.steer.test.ts` (new) or extend redesign tests

**Interfaces:**

- Produces something like:

```ts
async steerActiveTurn(input: { message: string; attachments?: ... }): Promise<void>
```

**Expected behavior (interrupt path):**

1. If no active turn → throw typed error `SteerNotActiveError` (UI should not offer steer when idle).
2. If active → `await interruptActiveTurn()`.
3. Enqueue/submit steer message as next user turn **immediately** (follow the working pattern from e2e: ensure next message is adopted, not lost).
4. Do **not** leave the message only in the passive queue behind other queued items if product defines steer as preemptive — document if queue ordering is FIFO after interrupt.

- [ ] **Step 1: Write unit test with mocked query.interrupt**

```ts
it("interrupts active turn then submits steer message", async () => {
  // arrange active query
  // call steerActiveTurn({ message: "stop and run tests" })
  // expect interrupt called
  // expect prompt/submit called with steer message
});
```

- [ ] **Step 2: Implement**

- [ ] **Step 3: Run**

```bash
npx vitest run packages/server/src/server/agent/providers/claude/agent.steer.test.ts --bail=1
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(claude): interrupt-and-submit steering for active turns"
```

---

### Task 3: AgentManager + session + client

**Files:**

- `agent-manager.ts` — public `steerAgent(agentId, payload)`
- `session.ts` — handle prompt flag or `agent.steer.request`
- capability projection: Claude `supportsSteer: true` when implementation present; OMP already steers via command — set true if accurate
- `daemon-client.ts` — `steerAgent` or `sendPrompt({ steer: true })`

- [ ] **Step 1: Tests for manager/session acceptance/error propagation**

- [ ] **Step 2: Implement wiring**

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(server): wire agent steering through session and client"
```

---

### Task 4: Composer UI affordance

**Files:**

- `packages/app/src/composer/input/input.tsx` / `labels.ts` / send menu
- i18n strings
- Tests for label/policy helpers

**UX:**

| Agent state | supportsSteer | Primary button  | Secondary |
| ----------- | ------------- | --------------- | --------- |
| Idle        | \*            | Send            | —         |
| Running     | false         | Queue           | —         |
| Running     | true          | Queue (default) | **Steer** |
| Locked      | \*            | disabled        | disabled  |

Implementation options (pick one consistent with existing send menu patterns):

1. Split button / long-press Send → “Steer instead”
2. Explicit toolbar control next to send when running + capable
3. Slash command `/steer …` client-side that calls steer API (plus button)

Prefer **(2) explicit control** for discoverability on mobile.

Copy:

```ts
composer.input.steer: "Steer"
composer.input.steerHint: "Interrupt the current turn with this message"
composer.input.steerUnavailableIdle: "Steer is only available while the agent is running"
```

- [ ] **Step 1: Pure policy tests** for when Steer is shown/enabled

- [ ] **Step 2: Wire control → client steer API with current text+attachments; clear draft on success like send**

- [ ] **Step 3: Interaction lock hides/disables Steer**

- [ ] **Step 4: typecheck + commit**

```bash
npm run typecheck
git commit -m "feat(app): add explicit Steer action for capable running agents"
```

---

### Task 5: OMP regression guard

**Files:** existing OMP steer tests

- [ ] **Step 1: Run OMP steer-related unit tests**

```bash
npx vitest run packages/server/src/server/agent/providers/omp/commands.test.ts packages/server/src/server/agent/providers/omp/agent.test.ts --bail=1
```

- [ ] **Step 2: Fix any accidental breakage**

- [ ] **Step 3: Commit only if fixes needed**

---

## Manual verification

1. Claude agent running a long turn.
2. Type “stop and summarize only” → **Steer**.
3. Current turn interrupts; agent follows new instruction without waiting for original completion.
4. **Queue** still queues a follow-up without interrupting.
5. Idle: Steer not available.
6. Lock on: Steer not available.
7. OMP `/steer` still works.

## Done when

- Capability + UI + Claude path green in unit tests
- Semantics documented in UI hint string
- No protocol breaks for old clients (optional fields)
