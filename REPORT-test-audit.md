# Codex MCP Test Audit Report

**Date**: 2025-12-25

## Test Results Summary

```
codex-mcp-agent.test.ts: 13 tests - ALL PASSED
codex-agent.test.ts: 15 tests - 1 failed, 1 skipped (deprecated SDK provider)
claude-agent.test.ts: All passed
agent-mcp.e2e.test.ts: 1 test - passed
```

## WORKAROUNDS FOUND

### 1. `codex-mcp-agent.test.ts:797-805` - read_file assertion skip

**Code:**
```typescript
// NOTE: Codex MCP does not expose a separate read_file tool.
// Reading files is done via shell commands (cat/head/tail) instead.
// The test prompt asks for read_file but Codex uses cat internally.
const readCall = toolCalls.find((item) => item.tool === "read_file");
// Skip assertion - Codex doesn't have a read_file tool
if (readCall) {
  expect.soft(stringifyUnknown(readCall.input)).toContain("tool-create.txt");
  expect.soft(stringifyUnknown(readCall.output)).toContain("beta");
}
```

**Claim**: "Codex MCP does not expose a separate read_file tool"

**VERIFICATION RESULT**: **FALSE - WORKAROUND IS HIDING A BUG**

Codex DOES expose file read information. Running `scripts/codex-file-read-debug.ts` shows:

```json
{
  "type": "exec_command_begin",
  "call_id": "call_1s8E3mD8vvA2A9NXZR9gzQYH",
  "command": ["/bin/zsh", "-lc", "cat /tmp/codex-debug-test-file.txt"],
  "parsed_cmd": [{
    "type": "read",
    "cmd": "cat /tmp/codex-debug-test-file.txt",
    "name": "codex-debug-test-file.txt",
    "path": "/tmp/codex-debug-test-file.txt"
  }]
}
```

**Root cause**: The `codex-mcp-agent.ts` provider is not detecting `parsed_cmd.type === "read"` on exec_command events and mapping them to `read_file` timeline items.

**Required fix**: Detect `exec_command_begin/end` events where `parsed_cmd[].type === "read"` and emit a `read_file` timeline item with:
- `tool: "read_file"`
- `input: { path: parsed_cmd[].path }`
- `output: { content: stdout from exec_command_end }`

---

### 2. `codex-mcp-agent.test.ts:819-821` - web_search output assertion removed

**Code:**
```typescript
// NOTE: Codex MCP web_search does not return search results in the event.
// The search happens internally but results are not exposed via MCP events.
// Only verify that the search was performed (input contains query).
```

**Claim**: "Codex MCP web_search does not return search results in the event"

**VERIFICATION RESULT**: **FALSE - WORKAROUND IS HIDING A BUG**

Codex DOES return web search results. Running `scripts/codex-websearch-debug.ts` shows:

```json
{
  "type": "mcp_tool_call_end",
  "call_id": "call_aTQ9yQJ7BpMkKjDe524GoRFJ",
  "invocation": {
    "server": "firecrawl",
    "tool": "firecrawl_search",
    "arguments": {"query": "Anthropic Claude information", "limit": 5}
  },
  "result": {
    "Ok": {
      "content": [{"text": "{\"web\": [{\"url\": \"...\", \"title\": \"...\", \"description\": \"...\"}]}"}]
    }
  }
}
```

**Root cause**: The `codex-mcp-agent.ts` provider is not extracting `result.Ok.content` from `mcp_tool_call_end` events and mapping it to the timeline item output.

**Required fix**: Extract `result.Ok.content[].text` from `mcp_tool_call_end` and include it in the `web_search` timeline item output.

---

### 3. `codex-agent.test.ts` - Permission test skipped

**Code:**
```typescript
↓ CodexAgentClient (SDK integration) > emits permission requests and resolves them when approvals are handled (awaiting Codex support)
```

**Status**: Skipped

**Reason**: The Codex SDK provider is DEPRECATED and replaced by the MCP provider. The SDK's `codex exec` command does not emit permission events. This is a known limitation of the SDK that was the reason for building the MCP provider.

**Recommendation**: Mark this test as deprecated, not skipped. Add a comment explaining the SDK is deprecated.

---

## Test Coverage Gaps

1. **No test for file read content capture**: The test asks Codex to read a file but doesn't verify that the file content appears in the timeline.

2. **No test for web search results**: The test asks Codex to search but doesn't verify search results appear in timeline output.

3. **Deprecated SDK test failure**: The persisted shell_command hydration test fails in the deprecated SDK provider. This is expected since the SDK is deprecated.

---

## Recommendations

### Critical Fixes Required

1. **`codex-mcp-agent.ts` lines ~1900-2000**: Add handler for `exec_command_begin/end` with `parsed_cmd.type === "read"` to emit `read_file` timeline items.

2. **`codex-mcp-agent.ts` lines ~1700-1800**: Extract `result.Ok.content` from `mcp_tool_call_end` events and include in timeline item output.

3. **`codex-mcp-agent.test.ts` lines 797-821**: Remove the `if (readCall)` workaround and the `// NOTE:` comments. The assertions should be unconditional once the provider is fixed.

### Test Improvements

1. Add explicit test case: "emits read_file timeline items when Codex reads files via cat"
2. Add explicit test case: "emits web_search results in timeline output"
3. Mark deprecated SDK tests clearly instead of skipping

---

## Evidence Files

- `scripts/codex-file-read-debug.ts` - Proves file read events are exposed
- `scripts/codex-websearch-debug.ts` - Proves web search results are exposed
- `test-audit.txt` - Full test run output
