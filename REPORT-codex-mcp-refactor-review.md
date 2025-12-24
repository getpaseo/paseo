# Codex MCP refactor review

Scope:
- packages/server/src/server/agent/providers/codex-mcp-agent.ts
- packages/server/src/server/agent/providers/codex-mcp-agent.test.ts
- packages/server/src/server/agent/agent-sdk-types.ts

Findings

1) Multi-key normalization remains in Codex MCP schemas (still “guessing” across multiple key names).
- Evidence:
  - Session identifiers normalize conversation id from multiple keys in `packages/server/src/server/agent/providers/codex-mcp-agent.ts:265-282`.
  - Read file items accept `path`, `file_path`, and `filePath` and merge output content from multiple fields in `packages/server/src/server/agent/providers/codex-mcp-agent.ts:605-650`.
  - MCP tool calls normalize `server`/`tool` across many alternative keys in `packages/server/src/server/agent/providers/codex-mcp-agent.ts:654-717`.
  - Permission params normalize `call_id`/`codex_call_id`/`codex_event_id` and `command`/`codex_command`, `cwd`/`codex_cwd` in `packages/server/src/server/agent/providers/codex-mcp-agent.ts:939-980`.

2) Related type definitions still use `Record<string, unknown>`.
- Evidence:
  - `packages/server/src/server/agent/agent-sdk-types.ts:17`, `:34`, `:94`, `:103`, `:105`, `:111`, `:132`, `:167`, `:170`.

Notes
- No `as` casts or `??` fallbacks were found in `packages/server/src/server/agent/providers/codex-mcp-agent.ts` or `packages/server/src/server/agent/providers/codex-mcp-agent.test.ts`.
- No `Record<string, unknown>` usage remains in the Codex MCP provider or its tests.
