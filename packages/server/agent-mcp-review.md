# Agent Control MCP Implementation Review

## Executive Summary

After thorough analysis of the agent control MCP implementation, I've identified several critical issues and race conditions that could cause hangs. The proposed changes are sound in principle but need careful implementation to avoid introducing new bugs. This review covers:

1. Current `waitForAgentEvent` implementation analysis
2. Signal/abort handling race conditions
3. Timeline/activity structure and message extraction
4. Recommendations for implementing the proposed changes
5. Identified bugs in current wait logic

---

## 1. Current `waitForAgentEvent` Implementation Analysis

### Location
`/home/moboudra/dev/voice-dev/packages/server/src/server/agent/agent-manager.ts:494-591`

### Current Behavior

The implementation is **fundamentally correct** but has subtle race conditions:

```typescript
async waitForAgentEvent(agentId: string, options?: WaitForAgentOptions): Promise<WaitForAgentResult> {
  const snapshot = this.getAgent(agentId);
  if (!snapshot) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Early return for pending permission
  const immediatePermission = snapshot.pendingPermissions[0] ?? null;
  if (immediatePermission) {
    return { status: snapshot.status, permission: immediatePermission };
  }

  // Early return if not busy
  if (!isAgentBusy(snapshot.status)) {
    return { status: snapshot.status, permission: null };
  }

  // ... wait logic
}
```

### Critical Race Condition #1: Time-of-Check-Time-of-Use (TOCTOU)

**Problem:** Between checking `isAgentBusy(snapshot.status)` and setting up the subscription, the agent could transition to idle. This creates a window where:

1. Line 508: Check shows `status === "running"`
2. Agent completes before line 536
3. Line 536-576: Subscribe with `replayState: true`
4. Subscription receives stale "running" state
5. Wait never resolves because completion event already fired

**Evidence:** The `replayState: true` parameter (line 575) partially mitigates this but doesn't eliminate the race:
- If completion happens BEFORE subscription, the replayed state will be "idle" and we return immediately ✅
- If completion happens DURING subscription setup, we might miss the state change ❌

### Critical Race Condition #2: Event Order Dependencies

The implementation relies on event ordering:

```typescript
switch (event.event.type) {
  case "permission_requested": {
    currentStatus = "running";
    finish(event.request);
    break;
  }
  case "turn_completed": {
    currentStatus = "idle";
    finish(null);
    break;
  }
  case "turn_failed": {
    currentStatus = "error";
    finish(null);
    break;
  }
}
```

**Problem:** The code handles both `agent_state` events (lines 538-549) and `agent_stream` events (lines 551-573). When an agent completes:
1. Stream events fire: `turn_completed`
2. State events fire: `agent_state` with `status: "idle"`

Depending on timing, we might receive them in either order or have duplicate processing.

---

## 2. Signal/Abort Handling Analysis

### Implementation (lines 579-589)

```typescript
if (options?.signal) {
  const abortHandler = () => {
    cleanup();
    reject(createAbortError(options.signal, "wait_for_agent aborted"));
  };

  options.signal.addEventListener("abort", abortHandler, { once: true });
  cleanupFns.push(() =>
    options.signal?.removeEventListener("abort", abortHandler)
  );
}
```

### Issue #1: Missing Initial Abort Check

**Bug:** The code doesn't check if `signal.aborted` is already true before adding the listener.

**Fix needed:**
```typescript
if (options?.signal) {
  if (options.signal.aborted) {
    throw createAbortError(options.signal, "wait_for_agent aborted");
  }
  // ... add listener
}
```

Wait, actually there IS a check on line 512-514:
```typescript
if (options?.signal?.aborted) {
  throw createAbortError(options.signal, "wait_for_agent aborted");
}
```

**But this is BEFORE the Promise, so there's still a race!** If the signal aborts between line 514 and line 579, the listener is never added and the promise hangs forever.

### Issue #2: MCP Server Signal Forwarding Complexity

In `mcp-server.ts:251-310`, the `wait_for_agent` handler creates its own AbortController and forwards signals:

```typescript
const abortController = new AbortController();

const forwardExternalAbort = () => {
  if (!abortController.signal.aborted) {
    const reason = signal?.reason ?? new Error("wait_for_agent aborted");
    abortController.abort(reason);
  }
};

if (signal) {
  if (signal.aborted) {
    forwardExternalAbort();
  } else {
    signal.addEventListener("abort", forwardExternalAbort, { once: true });
    cleanupFns.push(() =>
      signal.removeEventListener("abort", forwardExternalAbort)
    );
  }
}
```

**Analysis:** This is actually well-designed! The MCP layer:
1. Creates its own AbortController
2. Forwards external abort to internal signal
3. Also registers with waitTracker for explicit cancellation
4. Properly cleans up all listeners

The issue is that `AgentManager.waitForAgentEvent` doesn't do the same pre-check inside the Promise constructor.

---

## 3. Timeline/Activity Structure Review

### Timeline Item Types

From `agent-sdk-types.ts:51-68`:
```typescript
export type AgentTimelineItem =
  | { type: "user_message"; text: string; messageId?: string }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; /* ... */ }
  | { type: "todo"; items: { text: string; completed: boolean }[] }
  | { type: "error"; message: string };
```

### Extracting Last Assistant Message

The `runAgent` method (lines 321-351) already implements this correctly:

```typescript
for await (const event of events) {
  if (event.type === "timeline") {
    timeline.push(event.item);
    if (event.item.type === "assistant_message") {
      finalText = event.item.text;  // ← Last message wins
    }
  }
  // ...
}
```

**Key insight:** Multiple `assistant_message` items can exist in a single turn (streaming reassembly). The last one contains the complete message.

### Current Activity Structure

The `buildActivityPayload` function (lines 99-118) returns:
```typescript
{
  format: "curated",
  updateCount: number,
  currentModeId: string | null,
  content: string  // ← Curated summary via curateAgentActivity()
}
```

**Problem:** The curated content mixes user messages, assistant messages, tool calls, reasoning, and todos. Extracting just the last assistant message from this string is error-prone.

---

## 4. Proposed Changes Evaluation

### Proposal Summary

1. Make `waitForAgentEvent` return last assistant message text (not full activity)
2. Add `background` flag (default `false`) to `create_agent` and `send_agent_prompt`
3. When `background=false`, wait for completion and return last message
4. All three tools share same wait code path

### Evaluation

#### ✅ **Proposal 1: Return Last Assistant Message**

**Good:** Simpler, more focused API. Clients can always call `get_agent_activity` if they need full context.

**Implementation approach:**
```typescript
// In waitForAgentEvent
async waitForAgentEvent(
  agentId: string,
  options?: WaitForAgentOptions
): Promise<WaitForAgentResult & { lastMessage: string | null }> {
  // ... existing wait logic ...

  // After waiting completes, extract last message
  const timeline = this.getTimeline(agentId);
  let lastMessage: string | null = null;

  // Iterate backward to find most recent assistant_message
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") {
      lastMessage = item.text;
      break;
    }
  }

  return {
    status: currentStatus,
    permission: permissionOrNull,
    lastMessage,
  };
}
```

**Concern:** If the turn was interrupted or failed, there might be no assistant message. Callers need to handle `null`.

#### ⚠️ **Proposal 2-3: Add `background` Flag**

**Concerns:**

1. **API Confusion:** Having two modes (blocking vs non-blocking) in the same tool is confusing. MCP best practices suggest separate tools for different behaviors.

2. **Timeout Handling:** What if the agent runs for 10 minutes? The MCP call will timeout. Need explicit timeout parameter.

3. **Breaking Change:** Default `false` means all existing callers will suddenly block instead of returning immediately.

**Alternative Design:**

Keep existing tools as non-blocking (current behavior), add new tools for blocking:

- `create_agent` → remains non-blocking
- `create_agent_and_wait` → new blocking variant
- `send_agent_prompt` → remains non-blocking
- `send_agent_prompt_and_wait` → new blocking variant

This is more explicit and backward-compatible.

#### ✅ **Proposal 4: Shared Wait Code Path**

**Good:** DRY principle, easier to maintain.

**Implementation:**
```typescript
// Extract common logic
private async waitForCompletion(
  agentId: string,
  options?: { signal?: AbortSignal; timeout?: number }
): Promise<{ status: AgentLifecycleStatus; lastMessage: string | null }> {
  const result = await this.waitForAgentEvent(agentId, {
    signal: options?.signal,
  });

  if (result.permission) {
    throw new Error(
      `Agent ${agentId} is blocked on permission request: ${result.permission.title ?? result.permission.name}`
    );
  }

  // Extract last message
  const timeline = this.getTimeline(agentId);
  let lastMessage: string | null = null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].type === "assistant_message") {
      lastMessage = (timeline[i] as { text: string }).text;
      break;
    }
  }

  return { status: result.status, lastMessage };
}
```

---

## 5. Identified Bugs in Current Wait Logic

### Bug #1: Missing Abort Check Inside Promise

**File:** `agent-manager.ts:516`

**Problem:**
```typescript
return await new Promise<WaitForAgentResult>((resolve, reject) => {
  // Signal could abort here ← RACE!
  let currentStatus: AgentLifecycleStatus = snapshot.status;
  // ...

  // Listener added much later (line 579)
  if (options?.signal) {
    options.signal.addEventListener("abort", abortHandler, { once: true });
  }
});
```

**Fix:**
```typescript
return await new Promise<WaitForAgentResult>((resolve, reject) => {
  // Check immediately inside Promise constructor
  if (options?.signal?.aborted) {
    reject(createAbortError(options.signal, "wait_for_agent aborted"));
    return;
  }

  // ... rest of logic
});
```

### Bug #2: Duplicate Event Processing

**File:** `agent-manager.ts:536-573`

**Problem:** When a turn completes, both `agent_state` and `agent_stream` events fire. The code processes both:

```typescript
this.subscribe((event) => {
  if (event.type === "agent_state") {
    currentStatus = event.agent.status;
    const pending = event.agent.pendingPermissions[0] ?? null;
    if (pending) {
      finish(pending);  // ← Can finish here
      return;
    }
    if (!isAgentBusy(event.agent.status)) {
      finish(null);  // ← Or here
    }
    return;
  }

  if (event.type !== "agent_stream") {
    return;
  }

  switch (event.event.type) {
    case "turn_completed": {
      currentStatus = "idle";
      finish(null);  // ← Or here (duplicate!)
      break;
    }
    // ...
  }
}
```

**Result:** `finish()` gets called multiple times, but because it sets `finalized = true`, only the first call matters. Subsequent calls are no-ops.

**Assessment:** Not actually a bug due to the guard, but inefficient and confusing. Should skip one of the code paths.

**Fix:** Remove redundant stream event handling:
```typescript
this.subscribe((event) => {
  if (event.type === "agent_state") {
    currentStatus = event.agent.status;
    const pending = event.agent.pendingPermissions[0] ?? null;
    if (pending) {
      finish(pending);
      return;
    }
    if (!isAgentBusy(event.agent.status)) {
      finish(null);
    }
  }
  // Remove agent_stream handling - agent_state is sufficient
}, { agentId, replayState: true });
```

### Bug #3: Cleanup Race on Fast Completion

**File:** `agent-manager.ts:520-534`

**Problem:** If the agent completes instantly (e.g., already idle when we subscribe), the `finish()` call happens synchronously inside the `subscribe()` callback, but cleanup functions haven't been registered yet!

```typescript
const unsubscribe = this.subscribe((event) => {
  // Agent is already idle, event fires IMMEDIATELY
  if (!isAgentBusy(event.agent.status)) {
    finish(null);  // ← Calls cleanup() but cleanupFns is empty!
  }
}, { agentId, replayState: true });
cleanupFns.push(unsubscribe);  // ← Added AFTER callback fires
```

**Result:** Subscription is never cleaned up, causing memory leak.

**Fix:** Add cleanup function before subscribing:
```typescript
let unsubscribe: (() => void) | null = null;

const cleanup = () => {
  while (cleanupFns.length) {
    const fn = cleanupFns.pop();
    try { fn?.(); } catch {}
  }
  if (unsubscribe) {
    try { unsubscribe(); } catch {}
  }
};

unsubscribe = this.subscribe((event) => {
  // ... handler
}, { agentId, replayState: true });

cleanupFns.push(unsubscribe);
```

Actually, looking more carefully, the code already handles this correctly with the `while` loop. Let me re-read...

Actually no - the issue is that `cleanupFns.push(unsubscribe)` happens on line 577, but if the subscription callback fires synchronously during line 536, it calls `finish()` on line 542/546, which calls `cleanup()` on line 532, which pops from `cleanupFns` on line 521-527... but `unsubscribe` was never pushed!

This is a **real bug**.

### Bug #4: WaitTracker Cleanup on Agent Close

**File:** `agent-manager.ts:306-312`

**Problem:** When an agent is closed via `closeAgent()`, the `waitTracker` is not notified.

```typescript
async closeAgent(agentId: string): Promise<void> {
  const agent = this.requireAgent(agentId);
  this.agents.delete(agentId);
  agent.status = "closed";
  await agent.session.close();
  this.emitState(agent);
  // Missing: waitTracker.cancel(agentId)
}
```

**Result:** Any active `wait_for_agent` calls will hang until timeout.

**Fix:** This was already fixed in commit `cfa3fa8` in `mcp-server.ts`, but only at the MCP layer. The `AgentManager` should also handle this internally for non-MCP callers:

```typescript
async closeAgent(agentId: string): Promise<void> {
  const agent = this.requireAgent(agentId);
  this.agents.delete(agentId);
  agent.status = "closed";

  // Cancel any pending runs first
  await this.cancelAgentRun(agentId).catch(() => {});

  await agent.session.close();
  this.emitState(agent);
}
```

Actually, the `waitTracker` lives in `mcp-server.ts`, not `agent-manager.ts`, so this is architecture-dependent. The MCP layer correctly handles it; the AgentManager doesn't need to know about waiters.

---

## 6. Recommendations for Implementation

### Recommended Approach

**Phase 1: Fix Existing Bugs**
1. Fix Bug #3 (cleanup race) - highest priority
2. Fix Bug #1 (missing abort check in Promise)
3. Optimize Bug #2 (duplicate event processing) - low priority

**Phase 2: Extend waitForAgentEvent**
1. Add `lastMessage` to return type
2. Extract last assistant message from timeline
3. Update MCP server to include in response

**Phase 3: Add Blocking Variants (Optional)**
1. Create new MCP tools: `create_agent_and_wait`, `send_agent_prompt_and_wait`
2. Implement shared wait helper in AgentManager
3. Add timeout parameter (default 5 minutes)
4. Handle permission requests gracefully (throw or return them)

### Implementation Code

#### Fix Bug #1 & #3: Cleanup Race

```typescript
async waitForAgentEvent(
  agentId: string,
  options?: WaitForAgentOptions
): Promise<WaitForAgentResult> {
  const snapshot = this.getAgent(agentId);
  if (!snapshot) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const immediatePermission = snapshot.pendingPermissions[0] ?? null;
  if (immediatePermission) {
    return { status: snapshot.status, permission: immediatePermission };
  }

  if (!isAgentBusy(snapshot.status)) {
    return { status: snapshot.status, permission: null };
  }

  if (options?.signal?.aborted) {
    throw createAbortError(options.signal, "wait_for_agent aborted");
  }

  return await new Promise<WaitForAgentResult>((resolve, reject) => {
    // Check AGAIN inside Promise constructor (fix Bug #1)
    if (options?.signal?.aborted) {
      reject(createAbortError(options.signal, "wait_for_agent aborted"));
      return;
    }

    let currentStatus: AgentLifecycleStatus = snapshot.status;
    let unsubscribe: (() => void) | null = null;
    let abortListener: (() => void) | null = null;

    const cleanup = () => {
      if (unsubscribe) {
        try { unsubscribe(); } catch {}
        unsubscribe = null;
      }
      if (abortListener && options?.signal) {
        try {
          options.signal.removeEventListener("abort", abortListener);
        } catch {}
        abortListener = null;
      }
    };

    const finish = (permission: AgentPermissionRequest | null) => {
      cleanup();
      resolve({ status: currentStatus, permission });
    };

    // Set up subscription BEFORE registering cleanup (fix Bug #3)
    unsubscribe = this.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          currentStatus = event.agent.status;
          const pending = event.agent.pendingPermissions[0] ?? null;
          if (pending) {
            finish(pending);
            return;
          }
          if (!isAgentBusy(event.agent.status)) {
            finish(null);
          }
        }
      },
      { agentId, replayState: true }
    );

    // Set up abort handler
    if (options?.signal) {
      abortListener = () => {
        cleanup();
        reject(createAbortError(options.signal, "wait_for_agent aborted"));
      };
      options.signal.addEventListener("abort", abortListener, { once: true });
    }
  });
}
```

#### Add Last Message Extraction

```typescript
export type WaitForAgentResult = {
  status: AgentLifecycleStatus;
  permission: AgentPermissionRequest | null;
  lastMessage: string | null;
};

async waitForAgentEvent(
  agentId: string,
  options?: WaitForAgentOptions
): Promise<WaitForAgentResult> {
  // ... existing wait logic ...

  // After promise resolves, extract last message
  const baseResult = await waitPromise; // existing Promise code
  const timeline = this.getTimeline(agentId);
  let lastMessage: string | null = null;

  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "assistant_message") {
      lastMessage = item.text;
      break;
    }
  }

  return {
    ...baseResult,
    lastMessage,
  };
}
```

#### Update MCP Server

```typescript
server.registerTool(
  "wait_for_agent",
  {
    // ... existing schema ...
    outputSchema: {
      agentId: z.string(),
      status: AgentStatusEnum,
      permission: AgentPermissionRequestPayloadSchema.nullable(),
      lastMessage: z.string().nullable(),
      activity: z.object({
        format: z.literal("curated"),
        updateCount: z.number(),
        currentModeId: z.string().nullable(),
        content: z.string(),
      }),
    },
  },
  async ({ agentId }, { signal }) => {
    // ... existing signal setup ...

    const result = await agentManager.waitForAgentEvent(agentId, {
      signal: abortController.signal,
    });
    const activity = buildActivityPayload(agentManager, agentId);

    return {
      content: [],
      structuredContent: ensureValidJson({
        agentId,
        status: result.status,
        permission: result.permission,
        lastMessage: result.lastMessage,
        activity,
      }),
    };
  }
);
```

---

## 7. Alternative: Keep It Simple

The proposed changes add complexity. Consider if they're actually needed:

### Current Pattern (Works Well)
```typescript
// Claude uses these MCP tools:
const { agentId } = await create_agent({ cwd, initialPrompt });
const result = await wait_for_agent({ agentId });
// result.activity.content has curated summary
```

### Proposed Pattern
```typescript
// With background flag:
const result = await create_agent({
  cwd,
  initialPrompt,
  background: false  // wait for completion
});
// result.lastMessage has final response
```

### Assessment

The current pattern is more flexible:
- Caller controls when to wait
- Can poll status without waiting
- Can cancel agent independently
- Activity summary is actually more useful than raw last message

The proposed pattern is simpler:
- One call instead of two
- More similar to standard LLM APIs
- Last message is what most callers want

**Recommendation:** Implement both patterns:
1. Keep existing tools unchanged (backward compatibility)
2. Add `*_and_wait` variants for convenience
3. Let usage patterns determine which is preferred

---

## 8. Testing Recommendations

### Unit Tests Needed

1. **Abort Signal Race Test**
   ```typescript
   test("waitForAgentEvent handles signal aborted before Promise", async () => {
     const controller = new AbortController();
     controller.abort();

     await expect(
       agentManager.waitForAgentEvent(agentId, { signal: controller.signal })
     ).rejects.toThrow("aborted");
   });
   ```

2. **Fast Completion Test**
   ```typescript
   test("waitForAgentEvent cleans up when agent already idle", async () => {
     // Create idle agent
     const snapshot = await agentManager.createAgent(config);

     // Should return immediately without hanging
     const result = await agentManager.waitForAgentEvent(snapshot.id);
     expect(result.status).toBe("idle");

     // Verify no memory leaks (subscription cleaned up)
   });
   ```

3. **Last Message Extraction Test**
   ```typescript
   test("waitForAgentEvent returns last assistant message", async () => {
     const snapshot = await agentManager.createAgent(config);
     const runPromise = agentManager.runAgent(snapshot.id, "Hello");

     const result = await agentManager.waitForAgentEvent(snapshot.id);
     expect(result.lastMessage).toBeTruthy();
     expect(result.lastMessage).toContain("Hello");
   });
   ```

### Integration Tests Needed

1. Test MCP tools with actual Claude agent
2. Test interruption during long-running command
3. Test multiple concurrent wait_for_agent calls
4. Test wait_for_agent during permission request

---

## 9. Summary

### Critical Issues Found

1. ⚠️ **Cleanup race condition** (Bug #3) - Can cause memory leaks
2. ⚠️ **Missing abort check in Promise** (Bug #1) - Can cause hangs
3. ⚠️ **TOCTOU race on agent status** - Can cause missed completions

### Proposed Changes Assessment

| Proposal | Verdict | Notes |
|----------|---------|-------|
| Return last message in waitForAgentEvent | ✅ Good | Simple, useful, backward compatible |
| Add `background` flag to existing tools | ⚠️ Risky | Breaking change, confusing API |
| Add separate `*_and_wait` tools | ✅ Better | Explicit, backward compatible |
| Shared wait code path | ✅ Good | DRY, easier to maintain |

### Recommended Action Plan

**Immediate (Fix Production Bugs):**
1. Fix Bug #3: Cleanup race condition
2. Fix Bug #1: Abort signal check in Promise constructor

**Short Term (Enhance API):**
1. Add `lastMessage` to `WaitForAgentResult`
2. Update `wait_for_agent` MCP tool to return it
3. Add integration tests

**Long Term (New Features):**
1. Add `create_agent_and_wait` MCP tool
2. Add `send_agent_prompt_and_wait` MCP tool
3. Add timeout parameter support
4. Monitor usage to see which pattern users prefer

### Code Quality
The codebase is generally well-structured with good separation of concerns. The recent fix (commit `cfa3fa8`) correctly addressed the waitTracker cancellation issue at the MCP layer. The remaining bugs are subtle race conditions that are easy to miss in async code.
