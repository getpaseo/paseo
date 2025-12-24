# Claude test failures: real root cause

## Finding
The Claude E2E tests were not failing due to missing credentials in general; they were failing because the tests overwrite `CLAUDE_CONFIG_DIR` with a fresh temp directory and do **not** carry forward Claude's credential store. This removes the SDK's `.credentials.json` file when the SDK is running in plaintext storage mode (common in CI), so the SDK cannot load OAuth/API credentials even though the user has valid credentials in the default config directory.

## Evidence
- The Claude agent SDK stores credentials in a file named `.credentials.json` under its config directory:
  - `node_modules/@anthropic-ai/claude-agent-sdk/cli.js` shows the plaintext credential store path as `join(storageDir, ".credentials.json")`.
- The tests set `process.env.CLAUDE_CONFIG_DIR` to a temp dir in:
  - `packages/server/src/server/agent/providers/claude-agent.test.ts` (via `useTempClaudeConfigDir`)
  - `packages/server/src/server/agent/agent-mcp.e2e.test.ts`
- The temp config dir is populated with settings only, so the SDK can't find `.credentials.json` after the override.

## Fix summary
- Copy `.credentials.json` from the original config directory (explicit `CLAUDE_CONFIG_DIR` or `~/.claude`) into the temp config dir used by tests.
- Remove the hardcoded env-var-only credential precheck so tests fail with the *real* SDK error if credentials are genuinely absent.

## Files updated
- `packages/server/src/server/agent/providers/claude-agent.test.ts`
- `packages/server/src/server/agent/agent-mcp.e2e.test.ts`
