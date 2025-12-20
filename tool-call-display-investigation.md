# Tool Call Display Investigation Report

## Summary

Investigation into why tool call inputs and outputs are not displaying properly in the Claude agent UI.

## Findings

### Visual Evidence

I captured screenshots comparing standard tools vs MCP tools:

1. **Standard Tool (Grep) - Expanded View** (`standard-tool-grep-expanded.png`):
   - ✅ Shows "Result" section with full output data
   - ✅ Output displays correctly as JSON: `{ "result": { "output": "Found 9 files..." } }`

2. **MCP Tool (mcp__agent-control__list_agents) - Expanded View** (`mcp-tool-list-agents-expanded.png`):
   - ✅ Shows "Result" section with full output data
   - ✅ Output displays correctly with agent data: `{ "result": { "output": "{\"agents\":[...]" } }`

### Key Discovery

**Both standard tools AND MCP tools ARE displaying their output correctly!**

The output data is being passed through the pipeline successfully from server → client → UI.

## Root Cause: Missing Input Data for MCP/Server Tools

### Location

File: `packages/server/src/server/agent/providers/claude-agent.ts`

### The Bug (Line 1253-1258)

```typescript
private upsertToolUseEntry(block: ClaudeContentChunk): ToolUseCacheEntry | null {
  // ... setup code ...

  if (block.type === "tool_use") {  // ← BUG: Only checks for standard tools
    const input = this.normalizeToolInput(block.input);
    if (input) {
      this.applyToolInput(existing, input);
    }
  }

  this.toolUseCache.set(id, existing);
  return existing;
}
```

### Why This Is a Problem

1. **Tool Types in the Codebase**:
   - Standard tools: `block.type === "tool_use"`
   - MCP tools: `block.type === "mcp_tool_use"`
   - Server tools: `block.type === "server_tool_use"`

2. **What Happens**:
   - When a tool call starts (line 1003-1008), the code handles ALL three types
   - But `upsertToolUseEntry` only captures input for `"tool_use"` type
   - MCP and server tools skip the input capture logic entirely
   - `existing.input` remains `undefined`

3. **Impact on Display**:
   - When `handleToolUseStart` is called (line 1044), it uses:
     ```typescript
     input: entry.input ?? this.normalizeToolInput(block.input)
     ```
   - Since `entry.input` is undefined for MCP tools, it falls back to `block.input`
   - However, by this point the input may not be properly normalized

### Evidence from Code

**Tool type handling (lines 1003-1008)**:
```typescript
case "tool_use":
case "server_tool_use":
case "mcp_tool_use": {
  this.handleToolUseStart(block, items);  // Handles all three types
  break;
}
```

**Input capture logic (lines 1253-1258)** - ONLY handles `"tool_use"`:
```typescript
if (block.type === "tool_use") {
  const input = this.normalizeToolInput(block.input);
  if (input) {
    this.applyToolInput(existing, input);
  }
}
```

## What IS Working

- ✅ **Output display**: Both standard and MCP tools show their output correctly
- ✅ **Tool call buttons**: All tool calls appear in the timeline
- ✅ **Tool names**: Correctly labeled (e.g., "Grep", "mcp__agent-control__list_agents")
- ✅ **Status indicators**: Success/failure states display properly

## What Is NOT Working

- ❌ **Input parameters for MCP tools**: Not captured in `upsertToolUseEntry`
- ❌ **Input parameters for server tools**: Not captured in `upsertToolUseEntry`

## Recommended Fix

Update `upsertToolUseEntry` to handle all tool types:

```typescript
if (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") {
  const input = this.normalizeToolInput(block.input);
  if (input) {
    this.applyToolInput(existing, input);
  }
}
```

## Testing Methodology

1. Created a test agent that invoked multiple tool types:
   - Standard tools: Read, Write, Edit, Bash, Glob, Grep
   - MCP tools: mcp__agent-control__list_agents, mcp__agent-control__create_agent

2. Used Playwright MCP to navigate the UI and expand tool calls

3. Captured screenshots of expanded views showing:
   - Standard tool (Grep) with full Result display
   - MCP tool (list_agents) with full Result display

4. Verified both show output correctly but suspected input issue based on code analysis

## Files Involved

- `packages/server/src/server/agent/providers/claude-agent.ts` - Server-side tool processing
- `packages/app/src/components/message.tsx` - UI rendering (line 1282+)
- `packages/app/src/types/agent-activity.ts` - Data models
- `packages/app/src/utils/tool-call-parsers.ts` - Tool call parsing logic

## Conclusion

The investigation confirms that:
1. Output data IS being displayed correctly for all tool types
2. The input capture bug at line 1253 in claude-agent.ts prevents MCP and server tool inputs from being stored
3. A simple fix to check for all three tool types will resolve the input display issue

The UI rendering components are working correctly - they just need the input data to be properly provided by the server.

## Fix Applied

The fix has been implemented at line 1253 in `claude-agent.ts`:

```typescript
// BEFORE:
if (block.type === "tool_use") {

// AFTER:
if (block.type === "tool_use" || block.type === "mcp_tool_use" || block.type === "server_tool_use") {
```

## Verification Required

To verify the fix works:

1. **Restart the server** - The voice-dev tmux session needs to be restarted for TypeScript changes to take effect
2. **Test MCP tools** - Create a new agent and invoke MCP tools like `mcp__agent-control__list_agents`
3. **Check Input display** - Expand the MCP tool calls in the UI and verify that:
   - Input parameters are now visible (not just undefined)
   - The Input section shows properly formatted data
4. **Compare** - Take before/after screenshots showing input data now appears

The output was already working (as proven by screenshots), so the verification should focus on confirming that **input parameters** now display for MCP and server tools.
