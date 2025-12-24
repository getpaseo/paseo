# Codex MCP CLI / Model / Permission Mismatches

## Environment
- Codex CLI: codex-cli 0.77.0
- MCP command: `codex mcp-server` (selected by `getCodexMcpCommand` for 0.77.0)
- Test runner: `npm run test --workspace=@paseo/server -- <pattern> src/server/agent/providers/codex-mcp-agent.test.ts`

## Model mismatch (runtime info test)
- Test: `reports runtime info with provider, session, model, and mode`
- Config: provider=codex-mcp, modeId=full-access, model=gpt-4.1
- Expected: assistant replies `READY`, runtime info returns non-empty model/sessionId.
- Observed:
  - Codex CLI error: `http 400 Bad Request: The 'gpt-4.1' model is not supported when using Codex with a ChatGPT account.`
  - Test fails: `expected '' to contain 'ready'`.
- Notes:
  - CLI refuses the model at session start, so the run returns empty text and no runtime info.

## Permission elicitation mismatch (on-request)
- Test: `requests permission and resolves approval when allowed`
- Config: provider=codex-mcp, modeId=full-access, approvalPolicy=on-request
- Expected: `permission_requested` emitted, test captures permission request; `permission_resolved` after approving.
- Observed:
  - No permission request captured (`expected null not to be null`).
- Notes:
  - Suggests Codex CLI did not emit elicitation events despite approval-policy=on-request.

## Permission ordering mismatch (read-only/untrusted)
- Test: `requires permission before commands in read-only (untrusted) mode`
- Config: provider=codex-mcp, modeId=read-only (approvalPolicy=untrusted, sandbox=read-only)
- Expected: permission request appears before command timeline items.
- Observed:
  - No permission request captured (`expected null not to be null`).
- Notes:
  - Either CLI ignores approval-policy/sandbox or the event stream does not surface elicitation for MCP.

## Follow-up categories
- Model gating: choose a supported default model for ChatGPT accounts or skip runtime info test unless model available.
- Approval-policy/elicitation: confirm Codex CLI semantics for `approval-policy=on-request` and `untrusted` via MCP, and adjust tests or provider accordingly.

# Codex MCP Type/Quality Review

## High-signal follow-up tasks
- Reduce `unknown`/`Record<string, unknown>` casts in `codex-mcp-agent.ts` by defining typed event payloads for `codex/event` and thread item shapes.
- Replace ad-hoc `as` casts in timeline mapping with type guards (e.g., `isCommandExecutionEvent`, `isThreadItem`) and narrow types before access.
- Type `pendingPermissions` and `pendingPermissionHandlers` with stricter interfaces; remove `message` usage from `AgentPermissionResponse` or widen the union if needed.
- Introduce a typed wrapper for MCP client notifications so `raw` payloads are decoded once instead of casting per-event.
- Add a single source of truth for timeline item ids/call ids to avoid fallback to `unknown` data.

## Suggested task buckets
- Typecheck fixes for `AgentPermissionResponse` handling and unused locals.
- Event-shape typing and narrowing (MCP + thread/item types).
- Cleanup of `any`/`unknown` casts and `Record<string, unknown>` usage.
- Test adjustments for model availability and permission semantics.
