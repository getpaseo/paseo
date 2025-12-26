# Claude Streaming Regression Investigation

## Status: ROOT CAUSE IDENTIFIED

## Problem
Claude agent text is garbled/corrupted during streaming, with words cut off and merged incorrectly (e.g., "a" + "check error" instead of "a" + "type" + "check error"). This bug **ONLY appears in long-running agents** during the 2nd+ conversation turn, not during initial agent creation.

## Investigation Timeline

### Phase 1: App-Side Analysis (Passed)
- Added debug logging to React Native state management
- Verified Zustand state updates are correct
- Confirmed FlatList rendering is correct
- **Conclusion**: Bug is NOT in the app layer

### Phase 2: Server-Side Streaming Analysis (Passed)
- Added E2E test to verify server sends clean chunks during new agent creation
- Test passes - server correctly forwards all text_delta chunks from Claude SDK
- **Conclusion**: Bug is NOT in baseline streaming code

### Phase 3: Long-Running Agent Analysis (IDENTIFIED ROOT CAUSE)
- Realized the E2E test only tested NEW agents, not long-running scenarios with multiple turns
- Examined `claude-agent.ts` state management across multiple `stream()` invocations
- **ROOT CAUSE FOUND** in `claude-agent.ts`

## Root Cause

### Location
`packages/server/src/server/agent/providers/claude-agent.ts`

### The Bug: Race Condition with Shared State Flags

**File**: `packages/server/src/server/agent/providers/claude-agent.ts`

**Critical Lines**: 480-482 (fire-and-forget call)

```typescript
// Line 452-503: stream() method
async *stream(
  prompt: AgentPromptInput,
  _options?: AgentRunOptions
): AsyncGenerator<AgentStreamEvent> {
  const sdkMessage = this.toSdkUserMessage(prompt);
  const queue = new Pushable<AgentStreamEvent>();
  this.eventQueue = queue;
  // ...
  
  // BUG: forwardPromptEvents is not awaited!
  // This is a fire-and-forget call that allows race conditions
  this.forwardPromptEvents(sdkMessage, queue).catch((error) => {
    console.error("[ClaudeAgentSession] Unexpected error in forwardPromptEvents:", error);
  });

  // Immediately starts consuming from queue while forwardPromptEvents
  // is still running asynchronously
  try {
    for await (const event of queue) {
      yield event;
      if (event.type === "turn_completed" || event.type === "turn_failed") {
        finishedNaturally = true;
        break;
      }
    }
  } finally {
    // ...
  }
}
```

### The Mechanism: Shared State Across Turns

In a long-running agent with multiple turns:

1. **Turn 1**: User sends message
   - `stream()` called, creates generator instance 1
   - `forwardPromptEvents()` async method starts running (not awaited)
   - Flags `streamedAssistantTextThisTurn` and `streamedReasoningThisTurn` reset to false (line 769-770)
   - Stream events arrive, set flags to true
   - Final "assistant" message arrives, uses flag to suppress duplicate (line 824)

2. **Turn 2** (while Turn 1 is still processing): User sends another message
   - `stream()` called AGAIN, creates generator instance 2
   - Both generator instances share the **SAME ClaudeAgentSession object** with **SAME instance variables**
   - `forwardPromptEvents()` for Turn 2 resets the flags (line 769-770)
   - BUT if Turn 1's `forwardPromptEvents()` is still running, its stream_events are STILL coming in
   - The flag changes are now SHARED between both stream operations

### The Garbled Text Result

When flags get mixed up between concurrent `forwardPromptEvents()` calls:

1. Turn 2's `forwardPromptEvents()` resets `streamedAssistantTextThisTurn = false` (line 769)
2. Turn 1 is still streaming text_deltas and setting `streamedAssistantTextThisTurn = true` (line 1138)
3. When Turn 1's final "assistant" message arrives, it checks the flag (line 824)
4. The flag value is UNCERTAIN - it depends on which operation modified it last
5. If suppression logic fails, text from different chunks could be:
   - Partially suppressed (causing words to be cut off)
   - Duplicated (causing merging)
   - Out of order

## Affected Code Sections

### 1. The Fire-and-Forget Call (Line 480-482)
```typescript
this.forwardPromptEvents(sdkMessage, queue).catch((error) => {
  console.error("[ClaudeAgentSession] Unexpected error in forwardPromptEvents:", error);
});
```

**Problem**: No await. The async function runs in the background while the queue iteration starts immediately.

### 2. Shared Flags (Lines 368-369)
```typescript
private streamedAssistantTextThisTurn = false;
private streamedReasoningThisTurn = false;
```

**Problem**: These are instance variables shared across ALL calls to `stream()` on the same session object.

### 3. Flag Usage in Suppression Logic (Lines 823-826)
```typescript
case "assistant": {
  const timelineItems = this.mapBlocksToTimeline(message.message.content, {
    suppressAssistantText: this.streamedAssistantTextThisTurn,  // Uses shared flag!
    suppressReasoning: this.streamedReasoningThisTurn,           // Uses shared flag!
  });
```

**Problem**: Reads the shared flag value without synchronization.

### 4. Flag Mutation During Streaming (Lines 1138, 1149)
```typescript
if (context === "live") {
  this.streamedAssistantTextThisTurn = true;  // Mutates shared flag
}
// ...
if (context === "live") {
  this.streamedReasoningThisTurn = true;  // Mutates shared flag
}
```

**Problem**: Mutates shared state without coordination between concurrent operations.

## Why This Wasn't Caught by Tests

The E2E test in commit `e587547` creates a NEW Claude agent and sends messages sequentially to the SAME agent. While messages are sent back-to-back, the test waits for each response to complete (the `runPrompt()` calls don't overlap).

In the actual app during stress testing or rapid input, multiple `stream()` calls could overlap, causing the race condition.

## Proposed Fix

**Move the streaming flags from instance variables to local variables scoped to each `stream()` invocation.**

Replace instance variables:
```typescript
// REMOVE THESE
private streamedAssistantTextThisTurn = false;
private streamedReasoningThisTurn = false;
```

Add as parameters to `forwardPromptEvents()` and pass them through the call chain:
```typescript
async *stream(...) {
  // Local variables scoped to THIS invocation
  let streamedAssistantTextThisTurn = false;
  let streamedReasoningThisTurn = false;
  
  // Pass to forwardPromptEvents
  this.forwardPromptEvents(sdkMessage, queue, {
    streamedAssistantTextThisTurn,
    streamedReasoningThisTurn,
  }).catch(...);
}

private async forwardPromptEvents(
  message: SDKUserMessage, 
  queue: Pushable<AgentStreamEvent>,
  flags: { streamedAssistantTextThisTurn: boolean; streamedReasoningThisTurn: boolean }
) {
  flags.streamedAssistantTextThisTurn = false;  // Reset only this operation's flags
  flags.streamedReasoningThisTurn = false;
  // ... rest of implementation
}
```

This ensures each `stream()` invocation has its own isolated flags that can't interfere with concurrent operations.

## Verification Needed

Before this fix is applied:
1. Write a test that reproduces the race condition (overlapping `stream()` calls)
2. Verify the fix prevents the race condition
3. Run existing E2E tests to ensure no regressions

## Summary

The bug is a **classic race condition** caused by:
1. Non-awaited async function call (fire-and-forget)
2. Shared mutable state (instance variables)
3. Multiple concurrent consumers of that state (overlapping `stream()` calls)

This is a threading/concurrency issue, not a text encoding or protocol problem. The fix is to isolate state per operation rather than sharing it at the instance level.
