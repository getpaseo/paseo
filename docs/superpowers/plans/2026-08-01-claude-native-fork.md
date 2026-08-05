# Claude native fork Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When forking a Claude assistant turn, create a **new agent session** whose provider log is an SDK `forkSession` of the source, instead of only attaching curated chat history to a blank draft.

**Architecture:** Add `agent.native_fork` RPC. Server uses Claude Agent SDK `forkSession({ upToMessageId })` (already used by rewind in `providers/claude/rewind.ts`), then registers a **new** managed agent with the forked provider `sessionId` via resume/create path. Client turn-footer Fork prefers native when `supportsNativeFork` is true; otherwise keeps existing `agent.fork_context` draft flow.

**Tech Stack:** Claude Agent SDK `forkSession`, AgentManager, protocol capabilities, existing fork UI (`handleForkAssistantTurn`).

**Spec:** [docs/superpowers/specs/2026-08-01-p0-p1-release-train-design.md](../specs/2026-08-01-p0-p1-release-train-design.md) §3

## Global Constraints

- Claude-first. Other providers keep context-fork.
- Do not remove `agent.fork_context` — fallback for non-native providers and failed native.
- Source agent must remain unchanged (forked session id is new).
- Protocol optional fields + capability gate; no degraded multi-RPC simulation.
- UI label stays **Fork** (tab / new workspace targets unchanged).
- CLI/MCP native fork is **out of this plan** (app path only).
- Targeted tests only; typecheck/lint/format before commit.

## File map

| Path                                                               | Responsibility                                                        |
| ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `packages/protocol/src/messages.ts`                                | `agent.native_fork.request/response`, capability `supportsNativeFork` |
| `packages/server/src/server/agent/providers/claude/native-fork.ts` | Pure fork helper                                                      |
| `packages/server/src/server/agent/agent-manager.ts`                | `nativeForkAgent(...)` orchestration                                  |
| `packages/server/src/server/session.ts`                            | RPC handler                                                           |
| `packages/server/src/server/websocket-server.ts`                   | Feature flag if needed (`agentNativeFork`)                            |
| `packages/client/src/daemon-client.ts`                             | Client helper                                                         |
| `packages/app/src/agent-stream/view.tsx`                           | Prefer native fork in `handleForkAssistantTurn`                       |
| Provider capability projection                                     | Surface `supportsNativeFork` for Claude                               |

## Important as-is facts

- Rewind already calls:

```ts
const fork = await input.sdk.forkSession(input.sessionId, { upToMessageId: messageId });
input.setSessionId(fork.sessionId); // mutates SAME agent
```

Native fork must call the same SDK but **create a different agent** with `fork.sessionId`, leaving the source agent’s session id alone.

- Current UI fork builds a draft via `client.buildAgentForkContext` — keep that path for fallback.

---

### Task 1: Protocol + capability

**Files:**

- Modify: `packages/protocol/src/messages.ts` (and agent capability schemas / `agent-types` if separate)
- Test: `packages/protocol/src/messages.native-fork.test.ts` or extend agent feature schema tests

**Interfaces:**

- Produces:

```ts
// request
{
  type: "agent.native_fork.request",
  requestId: string,
  agentId: string,
  boundaryCursor?: AgentTimelineCursor,
  boundaryMessageId?: string,
  target: "tab" | "workspace",
  // optional placement for workspace target may reuse existing create fields later
}

// response
{
  type: "agent.native_fork.response",
  requestId: string,
  accepted: boolean,
  error: string | null,
  agentId?: string,
  workspaceId?: string,
}
```

- Capability on agent snapshot / provider capabilities:

```ts
// COMPAT(supportsNativeFork): added in v0.2.916
supportsNativeFork: z.boolean().optional().default(false);
```

Optional daemon feature:

```ts
// COMPAT(agentNativeFork): added in v0.2.916, drop after 2027-02-01
agentNativeFork: z.boolean().optional();
```

- [ ] **Step 1: Write schema + capability default tests**

- [ ] **Step 2: Run — FAIL**

```bash
npx vitest run packages/protocol/src --bail=1 -t "native_fork|supportsNativeFork"
```

- [ ] **Step 3: Implement schemas + register unions**

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "feat(protocol): add agent.native_fork RPC and supportsNativeFork"
```

---

### Task 2: Claude fork helper (does not mutate source)

**Files:**

- Create: `packages/server/src/server/agent/providers/claude/native-fork.ts`
- Create: `packages/server/src/server/agent/providers/claude/native-fork.test.ts`

**Interfaces:**

- Produces:

```ts
export async function forkClaudeSessionAtMessage(input: {
  sdk: ClaudeRewindSdk; // reuse interface from rewind.ts
  sessionId: string;
  upToMessageId: string;
}): Promise<{ forkedSessionId: string }>;
```

- [ ] **Step 1: Test with fake SDK**

```ts
it("returns forked session id without requiring setSessionId on source", async () => {
  const sdk = {
    forkSession: vi.fn(async () => ({ sessionId: "forked-1" })),
  };
  const result = await forkClaudeSessionAtMessage({
    sdk,
    sessionId: "source-1",
    upToMessageId: "msg-9",
  });
  expect(result.forkedSessionId).toBe("forked-1");
  expect(sdk.forkSession).toHaveBeenCalledWith("source-1", { upToMessageId: "msg-9" });
});
```

- [ ] **Step 2–4: Implement + pass + commit**

```bash
git commit -m "feat(claude): add non-mutating session fork helper"
```

---

### Task 3: AgentManager.nativeForkAgent

**Files:**

- Modify: `packages/server/src/server/agent/agent-manager.ts`
- Create/Modify tests: `packages/server/src/server/agent/agent-manager.native-fork.test.ts` (or extend existing)

**Interfaces:**

- Produces:

```ts
async nativeForkAgent(input: {
  sourceAgentId: string;
  boundaryMessageId: string; // resolved provider message id
  target: "tab" | "workspace";
  // workspace placement options as needed
}): Promise<{ agentId: string; workspaceId: string }>
```

**Algorithm:**

1. Load source managed agent; require Claude provider + `persistence.sessionId` (or runtime session id).
2. Resolve boundary to provider message id (reuse rewind/fork_context resolution helpers).
3. `forkClaudeSessionAtMessage` → `forkedSessionId`.
4. Create **new** agent id.
5. Resume/register new agent from persistence handle `{ provider: "claude", sessionId: forkedSessionId }` with config cloned from source (cwd, model, mode, workspaceId for tab target).
6. For `target: "workspace"`, create worktree/workspace first if product requires parity with current fork-to-new-workspace (match existing draft fork navigation expectations; if too large, v1 ship **tab only** and keep workspace target on context-fork — document in PR).
7. On any failure after fork: best-effort do not leave orphan running sessions; surface error.

**Prefer reusing** `resumeAgentFromPersistence` with overrides rather than inventing a third registration path.

- [ ] **Step 1: Unit test with mocked provider client/sdk** proving:
  - new agent id ≠ source
  - source session id unchanged
  - new agent session id is forked id

- [ ] **Step 2: Implement**

- [ ] **Step 3: Run tests**

```bash
npx vitest run packages/server/src/server/agent/agent-manager.native-fork.test.ts packages/server/src/server/agent/providers/claude/native-fork.test.ts --bail=1
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(server): nativeForkAgent creates Claude agent from forked session"
```

---

### Task 4: Session RPC + capability projection

**Files:**

- Modify: `packages/server/src/server/session.ts`
- Modify: Claude capability projection (`agent-projections` / provider registry) to set `supportsNativeFork: true` for Claude when SDK path available
- Modify: `websocket-server.ts` feature flag if used
- Client: `daemon-client.ts` method `nativeForkAgent(...)`

- [ ] **Step 1: Handler tests** (session harness or unit)

- [ ] **Step 2: Implement `case "agent.native_fork.request"`**

Validate boundary (cursor and/or message id) same as fork_context.

- [ ] **Step 3: Project capability on Claude agents**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(server): expose agent.native_fork RPC and Claude capability"
```

---

### Task 5: App prefers native fork

**Files:**

- Modify: `packages/app/src/agent-stream/view.tsx` (`handleForkAssistantTurn`)
- Test: unit test pure branch resolver if extracted

**Interfaces:**

- Extract pure helper for clarity:

```ts
export function resolveForkStrategy(input: {
  supportsNativeFork: boolean;
  hasNativeForkFeature: boolean;
}): "native" | "context";
```

- [ ] **Step 1: Test strategy helper**

- [ ] **Step 2: Implement handler branch**

```ts
if (strategy === "native") {
  const result = await client.nativeForkAgent({ agentId, boundary, target });
  // navigate to new agent tab or workspace like create-agent navigation
  return;
}
// existing context-fork draft path
```

Navigation for tab target should open the new `agentId` in the current workspace (not a draft tab). Reuse existing navigate-to-agent helpers used elsewhere after create.

On native failure: toast + optional fallback to context-fork **only if** user-safe; default is toast error without silent fallback (avoid double agents). Prefer explicit error.

- [ ] **Step 3: Ensure readOnly / interaction lock still disables fork**

- [ ] **Step 4: typecheck + commit**

```bash
npm run typecheck
git commit -m "feat(app): prefer Claude native fork when supported"
```

---

## Manual verification

1. Claude agent with multi-turn history.
2. Fork from turn footer → **same workspace tab** → new agent appears with prior context, source intact.
3. Continue on forked agent — does not rewrite source timeline.
4. Non-Claude provider still uses context-fork draft path.
5. Locked/read-only: fork control absent/disabled.

## Risks / spikes (do first if blocked)

- Mapping `AssistantTurnForkBoundary` / timeline cursor → Claude `upToMessageId` may need the same resolver rewind uses. Prefer sharing that resolver over duplicating.
- If `resumeAgentFromPersistence` cannot attach a freshly forked SDK session without extra Claude client APIs, spike a thin `createSession({ resume: forkedSessionId })` path in Claude provider.
