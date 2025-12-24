# Codex MCP vs Claude Provider Parity Audit

Scope: `packages/server/src/server/agent/providers/claude-agent.ts` vs `packages/server/src/server/agent/providers/codex-mcp-agent.ts`.

## Summary (gaps to close)
- Dynamic modes: Claude supports runtime mode changes with validation; Codex MCP marks `supportsDynamicModes: false` and only updates local config (no server-side mode validation or negotiation).
- Persistence: Claude persists sessions on disk and supports discovery/listing; Codex MCP stores history only in-memory (per-process) and does not implement `listPersistedAgents`.
- MCP server configuration: Claude merges default + user-specified MCP servers; Codex MCP does not pass `mcpServers` config through to the Codex MCP tool.
- Permission context: Claude permission requests carry tool metadata and optional updates; Codex MCP permission mapping is command-only (no file change metadata or generalized tool permissions).

## Capability Parity Checklist

| Area | Claude provider (evidence) | Codex MCP provider (evidence) | Parity status |
| --- | --- | --- | --- |
| Streaming events (assistant text, reasoning) | `mapBlocksToTimeline` handles text and reasoning chunks, including delta variants (`packages/server/src/server/agent/providers/claude-agent.ts:992`-`1039`). | MCP events map `agent_message`, `agent_reasoning(_delta)` into timeline items (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:1048`-`1109`). | **Mostly parity** (both stream text + reasoning).
| Tool invocation streaming | Handles tool use + tool result variants (`tool_use`, `mcp_tool_use`, `server_tool_use`, `tool_result`, `web_search_tool_result`, etc.) into tool_call timeline items (`packages/server/src/server/agent/providers/claude-agent.ts:1042`-`1056`). | Handles `exec_command_*`, `patch_apply_*`, `item.*` with `command_execution`, `file_change`, `mcp_tool_call`, `web_search`, `todo_list` mapping (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:1120`-`1535`). | **Partial parity** (Codex MCP maps fewer tool/result variants; no explicit handling for text editor or web fetch tool results).
| Session persistence/resume | Loads persisted history from `~/.claude/projects` and exposes `listPersistedAgents` (`packages/server/src/server/agent/providers/claude-agent.ts:202`-`222`, `930`-`970`). | Uses in-memory `SESSION_HISTORY` and stores conversation IDs in metadata only (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:110`, `363`-`376`, `647`-`679`). No `listPersistedAgents` implementation. | **Gap** (Codex MCP persistence is process-local, not discoverable).
| Abort/interrupt handling | Calls `query.interrupt()` and handles aborts on permission requests (`packages/server/src/server/agent/providers/claude-agent.ts:390`-`685`, `850`-`862`). | Cancels via `AbortController`, emits `turn_failed` on interrupt, no explicit MCP interrupt call (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:494`-`534`, `723`-`878`). | **Parity with caveat** (both expose `interrupt`, Codex MCP relies on aborting the tool call).
| Runtime info reporting | Captures model/mode/session IDs via SDK init and caches (`packages/server/src/server/agent/providers/claude-agent.ts:260`-`332`, `751`-`757`). | Captures model/mode/session ID from responses and events (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:560`-`620`, `880`-`1034`). | **Parity**.
| Mode switching | Validates mode IDs and sets `permissionMode` in SDK options (`packages/server/src/server/agent/providers/claude-agent.ts:269`-`279`, `540`-`545`). | `supportsDynamicModes: false`; `setMode` just mutates local config and current mode (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:61`-`67`, `588`-`606`). | **Gap** (no validated or negotiated mode changes).
| MCP server support | Always sets agent-control + Playwright MCP servers; merges user `mcpServers` (`packages/server/src/server/agent/providers/claude-agent.ts:557`-`585`). | No use of `config.mcpServers`; only passes `config.extra?.codex` (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:238`-`258`). | **Gap** (no MCP server configuration parity).
| Permission flow | Permission requests via SDK `canUseTool`, supports updates and handles resolution events (`packages/server/src/server/agent/providers/claude-agent.ts:540`-`545`, `783`-`841`). | Uses MCP `ElicitRequest` and builds command-only permission requests (`packages/server/src/server/agent/providers/codex-mcp-agent.ts:398`-`419`, `1552`-`1590`). | **Partial parity** (command-only context; no file-change tool permissions).
| listPersistedAgents | Implemented (reads filesystem) (`packages/server/src/server/agent/providers/claude-agent.ts:202`-`222`). | Not implemented in Codex MCP client. | **Gap**.

## Notes / Recommendations
1. If parity is required, Codex MCP should either implement `listPersistedAgents` and on-disk history storage or downgrade its `supportsSessionPersistence` flag to avoid misleading clients.
2. Codex MCP should accept `mcpServers` in `AgentSessionConfig` and pass through to the Codex tool arguments (similar to Claude merge behavior).
3. Dynamic mode parity requires either: (a) `supportsDynamicModes: true` with validation + server-side mode switching; or (b) documented limitation in UI.
4. Permission requests should include file-change context (path/kind) when applicable, not only command fields.

