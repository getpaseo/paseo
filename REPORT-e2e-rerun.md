# E2E Rerun Findings (full server tests)

## Command 1: Full suite
- Command: `npm run test --workspace=@paseo/server`
- Result: suite did not complete; multiple failures + skip; run interrupted after ~202s while stuck in `codex-mcp-agent.test.ts` at 3/13.

### Observed failures/skips
- `packages/server/src/server/agent/providers/codex-agent.test.ts`:
  - Failing test: "hydrates persisted shell_command tool calls with completed status"
  - Error: `expected undefined to be truthy`
  - Likely assertion line: `packages/server/src/server/agent/providers/codex-agent.test.ts:498` (`expect(commandEntry).toBeTruthy()`)
- Skipped test:
  - `packages/server/src/server/agent/providers/codex-agent.test.ts`:
    - "emits permission requests and resolves them when approvals are handled (awaiting Codex support)"

### Hang/interrupt details
- Run was interrupted manually after ~202s with the suite still at:
  - `src/server/agent/providers/codex-mcp-agent.test.ts` 3/13 tests
- No stack trace emitted before the interrupt.

## Command 2: Verbose codex-mcp run (diagnostic)
- Command: `npx vitest run packages/server/src/server/agent/providers/codex-mcp-agent.test.ts --reporter verbose`
- Result: interrupted after ~61s; test file reached 6/13 with failure count increasing (4 failed by time of interrupt).
- Last active tests before interrupt:
  - "captures tool call inputs/outputs for commands, file changes, file reads, MCP tools, and web search" (test 3/13)
  - "emits an error timeline item for failed MCP turns" (test 4/13)
  - "persists session metadata and resumes with history" (test 5/13)
- No failure stack traces emitted before interruption.
