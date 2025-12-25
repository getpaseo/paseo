# Codex MCP go-live audit

## Verdict
Not ready to ship Codex MCP as the default `codex` provider.

## Evidence (tests)
- Command: `npm run test --workspace=@paseo/server 2>&1 | tee test-output-live-audit.txt`
- Result: test run did not complete; interrupted after extended stall while running Claude tests.
- Failures and skips observed before interrupt:
  - `src/server/agent/providers/codex-agent.test.ts`:
    - 1 failed: `hydrates persisted shell_command tool calls with completed status` -> `expected undefined to be truthy`
    - 1 skipped: `emits permission requests and resolves them when approvals are handled (awaiting Codex support)`
  - `src/server/agent/providers/codex-mcp-agent.test.ts`:
    - Failed: `maps thread/item events for file changes, MCP tools, web search, and todo lists` -> `expected false to be true`
    - Failed: `captures tool call inputs/outputs for commands, file changes, file reads, MCP tools, and web search` -> `Test timed out in 240000ms`
    - Failed: `emits an error timeline item for failed MCP turns` -> `expected 0 to be greater than 0`
    - Failed: `persists session metadata and resumes with history` -> multiple assertions (missing metadata, tool outputs, and conversation id mismatch)
- Additional errors seen during run:
  - `codex_api::endpoint::responses` network errors for `https://chatgpt.com/backend-api/codex/responses` (timestamped in output)
  - Repeated `ClaudeAgentSDK` watcher errors (e.g., `UNKNOWN: unknown error, watch '/var/folders/.../vscode-git-*.sock'`) while running `claude-agent.test.ts`

## Evidence (typecheck)
- Command: `npm run typecheck --workspace=@paseo/server`
- Result: failed with:
  - `src/server/agent/agent-projections.ts(198,3): error TS2322: Type '{}' is not assignable to type 'JsonValue | undefined'.`
  - `src/server/agent/providers/claude-agent.ts(343,5): error TS2322: Type 'AgentSessionConfig' is not assignable to type 'ClaudeAgentConfig'.`

## Parity gaps vs Claude provider
- Tool call timeline mapping parity not met: thread/item events and tool call inputs/outputs fail (Codex MCP tests failing/timeouts).
- Error timeline parity not met: missing error timeline item for failed MCP turns.
- Persistence/resume parity not met: missing or unstable conversation metadata and tool outputs.
- Claude baseline not validated: `claude-agent.test.ts` did not complete due to repeated SDK watch errors; cannot confirm baseline parity.

## Workarounds/hacks check
- `rg -n "queuePermissionGatedEvent|ensurePermissionRequestFromEvent|pendingToolEvents|exec_approval_request|modelRejected" packages/server/src/server/agent/providers/codex-mcp-agent.ts` returned no matches.

## Conclusion
Blocking failures in Codex MCP tests, typecheck errors, and incomplete Claude baseline verification mean we cannot ship Codex MCP as the default provider yet.
