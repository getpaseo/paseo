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

- [x] **BUG**: Codex MCP agent returns 0 timeline events after daemon restart.
  - **Done (2025-12-25 19:13)**: Fixed by implementing disk-based timeline history loading in `codex-mcp-agent.ts`.

  **WHAT**: Added rollout file parsing to load persisted timeline from `~/.codex/sessions/` when `SESSION_HISTORY` is empty after daemon restart.

  **CHANGES**:
  - `codex-mcp-agent.ts:2-6`: Added imports for `fs`, `Dirent`, `os`, `path`
  - `codex-mcp-agent.ts:2521`: Added `resumeHandle` field to store handle for async loading
  - `codex-mcp-agent.ts:2530`: Save `resumeHandle` in constructor
  - `codex-mcp-agent.ts:2592-2596`: Load history from disk in `connect()` when `persistedHistory.length === 0`
  - `codex-mcp-agent.ts:2616-2628`: New `loadPersistedHistoryFromDisk()` method
  - `codex-mcp-agent.ts:3919-4181`: New helper functions: `resolveCodexSessionRoot()`, `findRolloutFile()`, `parseRolloutFile()`, `loadCodexPersistedTimeline()`, plus rollout entry parsing functions

  **TEST ADDED**:
  - `daemon.e2e.test.ts:1638-1757`: New test "Codex agent timeline survives daemon restart" that verifies timeline is preserved via `agent_stream_snapshot` message after resume

  **RESULT**: E2E test passes, typecheck passes. Timeline items are loaded from rollout files when resuming an agent after daemon restart.
