# Plan: Replace Self-ID MCP with Structured Agent Metadata

## Goals
- Remove the brittle Self-ID MCP flow entirely (no tools, no bridge, no prompt injection).
- Generate agent titles/branch names asynchronously via a structured-data prompt at creation time.
- Keep behavior deterministic in tests (no live LLM dependency).

## Constraints & Rules
- Skip title generation when an explicit title is provided, but still generate a branch if eligible.
- Do not generate anything if there is **no initial prompt**.
- Use a **single structured pass** with a **dynamic schema** (title only, branch only, or both).
- Use the same lightweight model approach as commit/PR generation (Haiku).
- Apply changes asynchronously (agent creation must not block).
- Fully remove all Self-ID MCP traces.

## Reference: Commit/PR Generation Pattern
- `packages/server/src/server/session.ts`
  - `AUTO_GEN_MODEL = "haiku"`
  - `generateCommitMessage()` / `generatePullRequestText()`
  - Uses `generateStructuredAgentResponse({ provider: "claude", model: AUTO_GEN_MODEL, internal: true, ... })`

## Removal Scope (Self-ID MCP)
- Delete or fully excise:
  - `packages/server/src/self-id-bridge/index.ts`
  - `packages/server/src/server/agent/agent-self-id-mcp.ts`
  - `packages/server/src/server/agent/self-identification-instructions.ts`
  - CLI command in `packages/cli/src/cli.ts` (`self-id-bridge`)
  - MCP server wiring in `packages/server/src/server/bootstrap.ts`
  - `paseoPromptInstructions` usage and `injectLeadingPaseoInstructionTag(...)` calls
- Update docs to remove Self-ID MCP references:
  - `docs/ui-agent-labels-spec.md`
  - `docs/unix-socket-mcp-plan.md`

## New Flow: Structured Metadata Generation
### Business Logic
- `needsTitle = !explicitTitle && initialPrompt`
- `needsBranch = initialPrompt && isPaseoOwnedWorktree && branchStillWorktreeName`
- If neither is needed, do nothing.

### Dynamic Schema (Single Pass)
- Title only: `{ title: string }`
- Branch only: `{ branch: string }`
- Both: `{ title: string, branch: string }`

### Prompt Shape
- Use the **user’s initial prompt** as input context.
- Add instructions for:
  - Title: short, descriptive, <= 60 chars.
  - Branch: lowercase slug, `[a-z0-9-/]`, no leading/trailing `-`, no `--`.

### Execution
- Use `generateStructuredAgentResponse` with:
  - `provider: "claude"`
  - `model: AUTO_GEN_MODEL` (Haiku)
  - `internal: true`
- Run **asynchronously after agent creation**, never blocking creation.
- Apply results:
  - `agentManager.setTitle(...)` only if `needsTitle`.
  - `renameCurrentBranch(...)` only if `needsBranch` and `validateBranchSlug(...)` passes.
- Log errors and continue (no create failure).

### Eligibility Checks for Branch Rename
- Reuse `isPaseoOwnedWorktreeCwd(...)` and `getCheckoutStatus(...)`.
- Only rename when `currentBranch === basename(repoRoot)` (same rule as Self-ID MCP).

## Integration Points
- `packages/server/src/server/session.ts`
  - `handleCreateAgentRequest(...)`
- `packages/server/src/server/agent/mcp-server.ts`
  - `create_agent` tool
- `packages/server/src/server/agent/agent-management-mcp.ts`
  - `create_agent` tool

## Tests (Deterministic, Hard Assertions)
### Unit Tests (new helper)
- Title generated when initial prompt exists and no explicit title.
- Title not generated when explicit title is provided.
- Branch generated when in Paseo worktree and branch still equals worktree folder name.
- No generation when initial prompt is missing.
- Schema selection: title only / branch only / both.

### Integration-ish Tests
- Create agent with **no title + initial prompt** → title updated asynchronously.
- Create agent in **Paseo worktree with random branch name** → branch renamed asynchronously.
- Use mocks/fakes for `generateStructuredAgentResponse` to avoid live LLM calls.

### Remove obsolete tests
- Self-ID MCP tests:
  - `packages/server/src/server/agent/agent-self-identification.e2e.test.ts`
  - `packages/server/src/server/daemon-e2e/self-id-mcp.e2e.test.ts`
  - `packages/server/src/server/agent/providers/codex-mcp-agent.paseo-instructions.test.ts`

## Verification
- Run typecheck after changes (required by repo instructions).

## Claude Auth Fallback (if live calls required)
```
ANTHROPIC_BASE_URL="https://api.z.ai/api/anthropic"
ANTHROPIC_AUTH_TOKEN="10a8f1daba084dbd885e80e9caa3154f.h0QZ5JwWqpqdZ6qv"
ANTHROPIC_API_KEY=""
```
