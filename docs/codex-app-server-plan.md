# Codex App Server Provider Plan

Reference doc pulled to: `/tmp/codex-app-server.md` (Codex app-server JSON-RPC protocol).

## Current Codex MCP behavior to understand (for parity decisions only)
- Session lifecycle: `codex` vs `codex-reply` tool calls, with session+conversation IDs cached and persisted for resume. `codex` starts new sessions; `codex-reply` continues. See `packages/server/src/server/agent/providers/codex-mcp-agent.ts`.
- Interrupts: `interrupt()` aborts the running turn, emits `turn_failed`, and **clears session/conversation IDs** because MCP cannot reliably continue after abort; it stores a resume file path for next run. (`interrupt`, `buildResumePrompt`, `findCodexResumeFile`).
- Resume/history: loads persisted timeline from rollout JSONL, stores curated history in persistence metadata, and injects history into developer instructions if resuming across new sessions.
- Commands: Custom prompts (`prompts:`) and skills are sourced from `~/.codex/prompts` and `~/.codex/skills` via `listCodexCustomPrompts` / `listCodexSkills`.
- Runtime metadata: report model, mode, sessionId; list models uses **app-server** already (`model/list`).

We will **not** preserve MCP-specific workarounds. This is a hard migration to app-server with no backwards compatibility.

## App-server capabilities to leverage
From the app-server spec (`/tmp/codex-app-server.md`):
- Initialization handshake (`initialize` + `initialized`).
- Thread lifecycle: `thread/start`, `thread/resume`, `thread/read`, `thread/list`, `thread/loaded/list`, `thread/fork`, `thread/archive`, `thread/unarchive`, `thread/rollback`.
- Turn lifecycle: `turn/start`, `turn/interrupt`, `turn/completed` with `status: completed | interrupted | failed`.
- Event stream: `item/started`, `item/completed`, `item/*/delta`, `turn/diff/updated`, `turn/plan/updated`, `thread/tokenUsage/updated`.
- Approvals: command/file change approvals via server-initiated JSON-RPC requests; app/tool call approvals via `tool/requestUserInput`.
- Model/mode discovery: `model/list`, `collaborationMode/list` (experimental), `skills/list`, `app/list`.

## Plan

### 1) Design the app-server client surface
- Create a JSON-RPC client with:
  - request/response correlation IDs
  - server-initiated notifications + server-initiated requests (approvals)
  - lifecycle controls: spawn `codex app-server`, initialize handshake, close/kill process
- Put it in a dedicated module (e.g. `packages/server/src/server/agent/providers/codex-app-server-client.ts`) so the provider stays thin and testable.

### 2) Define the new provider interface + mapping
- Add `codex-app-server-agent.ts` implementing `AgentClient` / `AgentSession` with parity to `codex-mcp-agent`:
  - `createSession`, `resumeSession`, `listPersistedAgents`, `listModels`, `getRuntimeInfo`, `listCommands`, `executeCommand`, `setMode`, `interrupt`, `streamHistory`, `stream`, `run`.
- Map app-server items to existing `AgentTimelineItem` shapes:
  - `agentMessage` -> assistant_message (support `item/agentMessage/delta` and final `item/completed`).
  - `commandExecution`/`fileChange` -> tool_call timeline items + approvals.
  - `mcpToolCall` -> tool_call timeline items (approval handled via `tool/requestUserInput`).
  - `plan` items -> existing plan timeline + plan updates from `turn/plan/updated`.
  - `turn/diff/updated` -> patch/timeline diff aggregation if we surface it today.
  - `thread/tokenUsage/updated` -> usage metrics (use as streaming usage if supported).
- Tool call schema compatibility (matches `packages/app/src/utils/tool-call-parsers.ts`):
  - apply_patch: `input.files[{path,kind?}]` + `result.files[{path,patch?}]`
  - read_file: `input.path` + `result{type:"read_file",path,content}`
  - use stable tool names (`apply_patch`, `read_file`, `shell`) so Zod schemas parse and UI labels normalize.

### 3) History, resume, and interrupt strategy (critical)
- **Warm resume** (same daemon):
  - keep threadId in memory and call `thread/resume` if the app-server indicates it is not loaded (or just on reconnect).
  - use `thread/loaded/list` to avoid redundant resumes.
- **Cold resume** (after daemon restart):
  - persist threadId + metadata in `AgentPersistenceHandle` (threadId is the only persisted id; **no legacy migration fields**).
  - call `thread/read` with `includeTurns: true` to rebuild the timeline for `streamHistory()`.
  - call `thread/resume` before sending new turns to rehydrate model context.
- **Interrupts**:
  - use `turn/interrupt` with `threadId` + current `turnId` and treat `turn/completed.status === "interrupted"` as a clean cancel.
  - do **not** clear threadId; keep conversation context so the next `turn/start` continues in the same thread.
  - only fall back to new thread if `thread/resume` or `turn/start` returns a not-found error.

### 4) Modes, models, commands, and metadata
- **Mode/model/reasoning changes continue in-place** (no new thread, no forced reset).
- Map Paseo `modeId` to app-server collaboration modes via `collaborationMode/list`:
  - At startup, call `collaborationMode/list` and cache presets.
  - Build a deterministic mapping by matching on capability fields (approval policy + sandbox policy + network access) to our three modes:
    - `read-only`: approvalPolicy ~ `onRequest`/`unlessTrusted` + sandboxPolicy `readOnly`
    - `auto`: approvalPolicy ~ `onRequest`/`unlessTrusted` + sandboxPolicy `workspaceWrite`
    - `full-access`: approvalPolicy `never` + sandboxPolicy `dangerFullAccess`
  - If the list does not expose these fields, log the raw payload and map by `id`/`label` with a static config table, then normalize to our mode ids.
  - Store both `modeId` and the underlying `collaborationModeId` in metadata for debugging.
- Model and reasoning effort changes are passed on each `turn/start` (and become defaults for future turns, per app-server behavior).
- Commands/skills:
  - Prefer `skills/list` from app-server to list supported skills per `cwd`.
  - Keep support for `prompts:` from `~/.codex/prompts` to preserve custom prompt commands.
  - For skill execution, use the app-server recommended `skill` input item instead of relying only on `$<skill>` text.

### 5) Provider registration and hard migration
- Replace `codex-mcp-agent` with `codex-app-server-agent` in `packages/server/src/server/agent/provider-registry.ts`.
- Remove feature flags and MCP fallbacks. All codex paths use app-server only.
- Update persistence metadata to store the app-server `threadId` as the canonical id. **No legacy migration fields**.

### 6) Tests: expand coverage + ensure parity (AC #1)
- Add a **mock app-server** test harness that emits JSON-RPC notifications to simulate:
  - streaming deltas, final items, plan updates, diff updates
  - command approvals + file change approvals + tool approvals
  - interrupt mid-turn and completion with `status: interrupted`
  - thread read/resume with stored turns
- Port/duplicate critical Codex MCP tests to run against the new provider:
  - history resume (warm + cold), persisted timeline rehydration
  - interrupts and subsequent resume behavior
  - permissions and approvals
  - command listing + execution (skills + prompts)
  - model list + runtime info metadata
- Update existing e2e tests to run with app-server provider only (remove MCP variants).

### 7) Implementation sequencing
1. Build JSON-RPC app-server client + unit tests.
2. Implement `codex-app-server-agent` session + core stream mapping.
3. Add history/resume support (thread/read + thread/resume).
4. Add approvals plumbing and tool call mapping.
5. Wire provider registry + persistence update.
6. Expand tests and make app-server the only provider.

## Collaboration mode mapping details (to implement)
- Add a small adapter:
  - `listCollaborationModes()` calls `collaborationMode/list` once per daemon start and caches the response.
  - `resolveCollaborationMode(modeId)` matches against the cached list using:
    - `approvalPolicy` + `sandboxPolicy` (preferred)
    - `id`/`label` fallback mapping table if fields are missing
  - If no match, fall back to a default mode (`auto`).
- Expose the resolved app-server mode in runtime info for visibility (include `collaborationModeId`).

## Notes on history changes (what will improve)
- MCP: forced new session on interrupt + history injected via `developer-instructions` using rollout parsing.
- App-server: keep threadId and resume directly, use `thread/read` to rebuild history and `thread/resume` to continue.
