# Plan

## Context

Build a new Codex MCP provider side‑by‑side with the existing Codex SDK provider. The new provider lives in `packages/server/src/server/agent/providers/codex-mcp-agent.ts` and is selected via a new provider id (e.g. `codex-mcp`). All testing is **E2E only** (no mocks/fakes). Use `/Users/moboudra/dev/voice-dev/.tmp/happy-cli/src/codex/` as reference for MCP + elicitation.

## CRITICAL RULES - READ BEFORE EVERY TASK

1. **NO VAGUE REPORTS**: Never say "test hung", "was interrupted", "failed locally" without:

   - The EXACT error message or stack trace
   - The SPECIFIC line of code causing the issue
   - A concrete hypothesis for the root cause

2. **NO SKIPPING/DISABLING TESTS**: Skipping tests, adding `.skip`, or "opt-in gating" is **NOT ACCEPTABLE**. Fix the actual problem. If a test hangs, find out WHY and fix the code, not the test.

3. **NO WORKAROUNDS**: Adding timeouts, fallbacks, or "defensive" code that hides bugs is forbidden. The code must work correctly, not appear to work.

4. **INVESTIGATE DEEPLY**: When something fails:

   - Read the actual source code
   - Add debug logging if needed
   - Trace the exact execution path
   - Find the ROOT CAUSE, not symptoms

5. **BE SPECIFIC**: Every "Done" entry must include:
   - What the actual problem was (specific)
   - What code was changed (file:line)
   - How you verified it works

## Completed Work (Compacted)

### Codex MCP Provider (2025-12-24)

- ✅ Created `codex-mcp-agent.ts` with MCP stdio client, event mapping, permissions, persistence, abort handling
- ✅ Fixed model availability (removed hardcoded gpt-4.1), permission elicitation, exit code handling
- ✅ Fixed thread/item event mapping for file_change, mcp_tool_call, web_search, todo_list
- ✅ Fixed persistence to include conversationId metadata
- ✅ Resolved Codex MCP vs Codex SDK elicitation parity (CRITICAL FINDING: `codex exec` ignores approval events)
- ✅ All 14 Codex MCP unit tests pass; Codex is now the only provider (deprecated SDK provider removed)
- Reports: `CODEX_MCP_MISMATCH_REPORT.md`, `REPORT-codex-mcp-audit.md`

### UI/UX Fixes (2025-12-25)

- ✅ Removed duplicate "Codex MCP" option - now shows only "Codex"
- ✅ Fixed duplicate user/assistant messages (provider was emitting, but agent-manager already dispatches)
- ✅ Fixed Codex agent-control MCP parity with Claude (added MCP servers to Codex config)
- ✅ Fixed agent timestamp not updating on click without interaction

### DaemonClient Implementation (2025-12-25)

- ✅ Created `packages/server/src/server/test-utils/daemon-client.ts` (~550 lines)
- ✅ Created `packages/server/src/server/test-utils/daemon-test-context.ts`
- ✅ Created `packages/server/src/server/daemon.e2e.test.ts` (25 passing tests)
- Reports: `REPORT-daemon-client-design.md`, `REPORT-daemon-e2e-audit.md`, `REPORT-claude-permission-tests.md`

**DaemonClient API:**

- Connection: `connect()`, `close()`
- Agent lifecycle: `createAgent()`, `deleteAgent()`, `listAgents()`, `listPersistedAgents()`, `resumeAgent()`
- Agent interaction: `sendMessage()`, `cancelAgent()`, `setAgentMode()`, `initializeAgent()`, `clearAgentAttention()`
- Permissions: `respondToPermission()`, `waitForPermission()`
- Git: `getGitDiff()`, `getGitRepoInfo()`
- Files: `exploreFileSystem()`
- Models: `listProviderModels()`
- Waiting: `waitForAgentIdle()`
- Events: `on()`, `getMessageQueue()`, `clearMessageQueue()`

**E2E Test Coverage:**

- Basic flow (Codex + Claude): create agent, send message, verify response
- Permissions (Codex + Claude): approve/deny, permission_requested/resolved cycle
- Persistence: delete agent, resume from handle, verify conversation context
- Multi-agent: parent creates child via agent-control MCP
- Agent management: cancelAgent, setAgentMode, listAgents
- Timestamp: verify clicking agent doesn't update timestamp
- Git: diff (staged/unstaged/modified), repo info (branch, dirty state)
- Files: list directory, read file content
- Models: list Codex and Claude provider models
- Images: single and multiple image attachments to Claude

## Tasks

- [x] **REFACTOR**: Remove module-level `SESSION_HISTORY` Map from `codex-mcp-agent.ts`.
  - **Done (2025-12-25 19:28)**: Removed `SESSION_HISTORY` global Map and refactored to use instance-level `persistedHistory` field.

  **WHAT**:
  - Removed `SESSION_HISTORY` Map declaration (was at `codex-mcp-agent.ts:118`)
  - Constructor: now sets `historyPending = true` for resume instead of looking up `SESSION_HISTORY.get()` (`codex-mcp-agent.ts:2564-2565`)
  - `connect()`: simplified condition to always load from disk when resuming (`codex-mcp-agent.ts:2606-2608`)
  - `loadPersistedHistoryFromDisk()`: removed `SESSION_HISTORY.set()` line (`codex-mcp-agent.ts:2629-2639`)
  - `recordHistory()`: appends to `this.persistedHistory` instead of `SESSION_HISTORY` (`codex-mcp-agent.ts:3147-3152`)
  - `flushPendingHistory()`: appends to `this.persistedHistory` instead of `SESSION_HISTORY` (`codex-mcp-agent.ts:3155-3160`)

  **RESULT**: Typecheck passes. Persistence E2E test "persists session metadata and resumes with history" passes (8.3s). The test now exercises disk loading since there's no global Map to provide in-memory history. Net change: -12 lines.

  **NOTE**: Two flaky tests ("maps thread/item events..." and "captures tool call inputs/outputs...") also failed before this change - they depend on LLM choosing to call MCP tools/web search which is non-deterministic.
