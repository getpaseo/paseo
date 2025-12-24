# Codex MCP Tool Call Coverage E2E Failures

## Test Command

`npm run test --workspace=@paseo/server -- codex-mcp-agent.test.ts -t "captures tool call inputs/outputs"`

## Failing Assertions

Test: `CodexMcpAgentClient (MCP integration) > captures tool call inputs/outputs for commands, file changes, file reads, MCP tools, and web search`

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:532`
  - `fileChangeCalls.some((item) => stringifyUnknown(item.output).includes("tool-create.txt"))`
  - Output does not contain the file path; indicates `file_change` tool output is missing file metadata.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:535`
  - `const readCall = toolCalls.find((item) => item.tool === "read_file")`
  - No `read_file` tool call captured.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:536`
  - `stringifyUnknown(readCall?.input)` did not include `tool-create.txt`.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:537`
  - `stringifyUnknown(readCall?.output)` did not include `beta`.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:542`
  - `const mcpCall = toolCalls.find((item) => item.server === "test" && item.tool === "echo")`
  - No MCP tool call captured.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:543`
  - `stringifyUnknown(mcpCall?.input)` did not include `mcp-ok`.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:544`
  - `stringifyUnknown(mcpCall?.output)` did not include `mcp-ok`.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:549`
  - `const webSearchCall = toolCalls.find((item) => item.server === "web_search" && item.tool === "web_search")`
  - No web search tool call captured.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:550`
  - `stringifyUnknown(webSearchCall?.input)` did not include `OpenAI Codex MCP`.

- `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts:551`
  - `webSearchCall?.output` was undefined; web search results not captured.

## Hypotheses

- The Codex MCP provider may not be emitting `tool_call` timeline items for `read_file`, MCP tool calls, and `web_search` in this scenario, or the model is not executing the requested tools despite explicit prompts.
- File change timeline output appears to omit file metadata (e.g., `{ files: [{ path, kind }] }`), so the apply_patch completion output is not surfaced in timeline items.
