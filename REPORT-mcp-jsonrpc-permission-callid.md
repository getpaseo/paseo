# MCP JSONRPC permission call_id error

## Summary
- Observed JSONRPC error during `npm run test --workspace=@paseo/server`:
  - `permission call_id provided multiple times (codex_call_id, codex_mcp_tool_call_id, codex_event_id)`
- Error originates from the Codex MCP elicitation request handler in `packages/server/src/server/agent/providers/codex-mcp-agent.ts`.

## Root Cause
- `PermissionParamsSchema` used an exclusive resolver for `call_id`, rejecting payloads that include multiple call-id aliases.
- The Codex MCP server sends permission params with multiple call-id fields at once and they are **not identical**:
  - Example from `scripts/codex-mcp-elicitation-test.ts` (on-request): `codex_call_id = "call_..."`, `codex_mcp_tool_call_id = "2"`, `codex_event_id = "2"`.
  - The exclusive resolver raised a Zod error, surfaced as the MCP JSONRPC error in tests.

## Fix
- Added `resolvePreferredString` to select the canonical permission call id in a priority order.
- Updated `PermissionParamsSchema` to prefer `codex_call_id` when present, falling back to `codex_mcp_tool_call_id`, `codex_event_id`, then `call_id`.

## Files
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts`
- `REPORT-mcp-jsonrpc-permission-callid.md`
