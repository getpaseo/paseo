# Report: Claude Assistant Text Garbled Bug Investigation

**Date**: 2025-12-25
**Task**: BUG (App-side): Claude assistant text garbled in React Native app rendering

## Summary

After extensive investigation with debug logging in `appendAssistantMessage` and Playwright MCP testing, I've identified that the bug appears to be caused by **incomplete/corrupted text chunks being sent from the server**, not a client-side race condition.

## Evidence

### Debug Logging Added
- Added comprehensive logging to `appendAssistantMessage` in `packages/app/src/types/stream.ts:216-254`
- Logs capture: input text, normalized chunk, hasContent flag, state length, and append operations

### Observed Garbled Text Pattern
From console logs during live agent streaming:

```
[appendAssistantMessage] input=" agent" → NEW_MESSAGE (stateLen: 49→50)
[appendAssistantMessage] input=" a" → APPEND: " agent" + " a" = " agent a" (stateLen: 50)
[appendAssistantMessage] input="check error. Let me" → APPEND: " agent a" + "check error. Let me" = " agent acheck error. Let me"
```

**Key Observation**: The text "type" is missing between " a" and "check error" - it should have been "a **type**check error" but became "acheck error".

### Snapshot Hydration Works Correctly
When the agent_stream_snapshot is loaded, hydration works correctly:
```
[appendAssistantMessage] input="Foun" chunk="Foun" → NEW_MESSAGE
[appendAssistantMessage] input="d the" → APPEND: "Foun" + "d the" = "Found the"
[appendAssistantMessage] input=" "" → APPEND: "Found the" + " "" = "Found the ""
...continues correctly...
```

## Analysis

1. **Client-side state management is correct**: The `appendAssistantMessage` function correctly appends chunks to the last assistant_message item.

2. **Zustand updates work correctly**: Sequential updates via `setAgentStreamState` with functional updaters correctly receive previous state.

3. **The server is sending incomplete chunks**: The WebSocket log shows the server sending " a" then "check error. Let me" with no "type" in between.

4. **E2E test passes because it tests fresh agents**: The E2E test (`daemon.e2e.test.ts:1760-1881`) creates a new agent and watches live streams. It doesn't test the specific edge case causing this bug.

## Root Cause Hypothesis

The most likely causes are:

1. **Server-side buffering/chunking issue with Claude API**: The server may be incorrectly splitting Claude's streaming response, causing partial tokens to be lost.

2. **WebSocket message fragmentation**: Messages might be getting truncated or corrupted during transmission.

3. **Timeline event deduplication on server**: Some events might be filtered incorrectly.

## Recommended Next Steps

1. Add server-side logging in the Claude agent provider (`packages/server/src/server/agent/providers/`) to capture exact chunks received from Claude API before sending to clients.

2. Compare server-side received chunks vs client-side received chunks to identify where corruption occurs.

3. Check if there's any message coalescing or deduplication logic on the server that might be dropping chunks.

## Files Modified
- `packages/app/src/types/stream.ts:216-254` - Added debug logging to `appendAssistantMessage`

## Files That May Need Investigation
- `packages/server/src/server/agent/providers/claude-agent.ts` - Claude agent streaming implementation
- `packages/server/src/server/agent/agent-manager.ts` - Timeline event handling
- WebSocket message handling code
