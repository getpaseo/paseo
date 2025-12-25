# Codex MCP thread/item mapping investigation

## Summary
- Updated provider parsing for raw_response_item variants (web_search_call, function_call, custom_tool_call), normalized tool names (mcp__server__tool), and parsed JSON string tool arguments.
- Added MCP test server setup to reliably resolve SDK imports (createRequire with repo root package.json) and added a todo_list tool to the test MCP server.
- Added test-side fallback parsing for raw_response_item wrapper shapes plus fallback to timeline items for missing item types.

## Current failure
Test: `CodexMcpAgentClient (MCP integration) > maps thread/item events for file changes, MCP tools, web search, and todo lists`

Latest failure output:
```
FAIL  src/server/agent/providers/codex-mcp-agent.test.ts > CodexMcpAgentClient (MCP integration) > maps thread/item events for file changes, MCP tools, web search, and todo lists
AssertionError: expected false to be true // Object.is equality

- Expected
+ Received

- true
+ false

❯ src/server/agent/providers/codex-mcp-agent.test.ts:640:51
  638|         expect(sawItemEvent).toBe(true);
  639|         expect(rawItemTypes.has("file_change")).toBe(true);
  640|         expect(rawItemTypes.has("mcp_tool_call")).toBe(true);
  641|         expect(rawItemTypes.has("web_search")).toBe(true);
  642|         expect(rawItemTypes.has("todo_list")).toBe(true);
```

## Evidence collected
- Direct MCP debug run shows Codex emits raw_response_item types:
  - `web_search_call`
  - `function_call` with `name: "mcp__test__todo_list"` and JSON string `arguments`
  - `function_call` with `name: "mcp__test__echo"`
  - `custom_tool_call` with `name: "apply_patch"`

This indicates tool-call items are emitted, but the test still fails to observe `mcp_tool_call` in `rawItemTypes` despite fallback parsing.

## Hypotheses
1) Provider is not emitting provider_event for raw_response_item in the test run (or raw_response_item is wrapped differently than parseProviderEvent handles).
2) Timeline items for MCP tools are still not emitted, so fallback `rawItemTypes` population never sees `mcp_tool_call`.

## Attempts
- Added `RawWebSearchCallSchema`, normalized tool names, and JSON parsing of tool `arguments` in `packages/server/src/server/agent/providers/codex-mcp-agent.ts`.
- Added direct raw_response_item handling in `CodexMcpAgentSession.handleMcpEvent` to emit item.completed and process thread items before normalizeEvent.
- Expanded test-side parsing of raw_response_item (and nested wrapper `data`) in `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts`.
- Added test MCP server todo_list tool and ensure SDK imports resolve via createRequire.

## Next steps
- Add temporary logging around `handleMcpEvent` to confirm whether raw_response_item events (function_call) are arriving in the test run and whether `mapRawResponseItemToThreadItem` returns `mcp_tool_call`.
- If provider receives raw_response_item, trace why `ThreadItemEventSchema.parse` drops it (invalid item shape?)
- If provider does not receive raw_response_item, inspect MCP event wrapping shape in `codex/event` notifications during the test run (compare with direct MCP client debug script).
