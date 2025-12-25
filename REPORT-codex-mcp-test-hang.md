# Codex MCP test hang investigation

## Test that appeared stuck
- `CodexMcpAgentClient (MCP integration) > maps thread/item events for file changes, MCP tools, web search, and todo lists`
- Wait loop: `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:577` (`for await (const event of session.stream(prompt))` until `turn_completed`/`turn_failed`)

## What was actually happening
- The test was slow (40s+) because the Codex MCP server performed multiple tool call cycles before completing the turn.
- The run ultimately failed (not a true deadlock) because the MCP tool call timeline item never appeared, so `rawItemTypes.has("mcp_tool_call")` stayed false.

## Root cause
- Codex MCP server emits `mcp_tool_call_begin` and `mcp_tool_call_end` events with tool invocation + result payloads.
- `codex-mcp-agent.ts` handled raw_response_item tool calls but ignored `mcp_tool_call_*` events, so MCP tool calls were never mapped to timeline items when those events were the only reliable signal.

## Evidence
- Observed event shapes from Codex MCP:
  - `mcp_tool_call_begin` with `call_id` and `invocation` (server/tool/arguments)
  - `mcp_tool_call_end` with `result.Ok.structuredContent`
- When mapping those events to tool_call timeline items, the test passed.

## Fix
- Add schemas + handlers for `mcp_tool_call_begin`/`mcp_tool_call_end` in `packages/server/src/server/agent/providers/codex-mcp-agent.ts`.
- Emit `tool_call` timeline items for running/completed MCP tool calls and surface structured tool output.
