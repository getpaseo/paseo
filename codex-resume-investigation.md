# Codex ACP Session Persistence & Resume Investigation

## Summary
- PR [#66](https://github.com/zed-industries/codex-acp/pull/66) adds real session persistence to `@zed-industries/codex-acp`: CLI flags/env vars enable it, and each session is persisted in `${CODEX_HOME}/sessions/manifest.jsonl` with rollout paths, MCP servers, cwd, approval/mode settings, and timestamps. `loadSession` pulls that manifest entry, restores MCP config, and calls `ConversationManager::resume_conversation_from_rollout` with the saved rollout JSONL. Internal state resumes correctly.
- The ACP protocol surface still only returns mode/model selectors during `loadSession` (`codex-acp/src/conversation.rs:1585-1650`). Historical chat updates are **not** replayed: `ConversationActor::handle_load` never emits prior `SessionUpdate`s, and the event dispatcher drops any replay stream because there’s no active submission entry to consume it (`codex-acp/src/conversation.rs:1830-1840`). Clients are expected to have stored the transcript themselves.
- Our voice-dev server currently treats Codex as non-resumable (`supportsSessionPersistence: false` in `packages/server/src/server/acp/agent-types.ts`). `AgentManager` only attempts `loadSession` for Claude agents, so Codex sessions that the app starts get lost once the daemon dies. Agents launched outside the app aren’t tracked anywhere either.
- For CloudCode we solved this by forking the ACP package to replay history and by persisting agent metadata (session ids, rollout paths) in `agents.json`. Codex’s manifest already contains the same data; we can read it after each `newSession` and store it alongside the agent entry. On restart we can resume by calling `/session/load` with that data and replaying the rollout ourselves to rebuild UI history.

## Key Details
- **CLI & Manifest (PR #66)**
  - `codex-acp/src/cli.rs` parses `--session-persist`, `--session-persist=<dir>`, `--no-session-persist`, and the env vars `CODEX_SESSION_PERSIST`/`CODEX_SESSION_DIR`.
  - `SessionPersistCli` feeds into `SessionPersistenceSettings::resolve`, defaulting to `${CODEX_HOME}/sessions` (`codex-acp/src/session_store.rs:55-94`).
  - `SessionRecord` captures session id, conversation id, rollout path, cwd, MCP server definitions (including HTTP headers), model/mode ids, approval/sandbox policies, reasoning effort, and timestamps (`codex-acp/src/session_store.rs:21-90`). `SessionStore` writes JSONL manifest entries and exposes `record_session`, `update_model`, `update_mode`, etc.
- **Resume Flow**
  - When a new session is created, Codex ACP records a manifest entry before returning (`codex-acp/src/codex_agent.rs:373-414`).
  - On resume, Codex ACP reads the manifest, clones the saved MCP config/cwd, feeds it to `ConversationManager::resume_conversation_from_rollout`, and updates the manifest (`codex-acp/src/codex_agent.rs:415-498`).
  - `ConversationManager` loads the rollout history via `RolloutRecorder::get_rollout_history` and spawns Codex with that history (`codex-rs/core/src/conversation_manager.rs:128-177`), so Codex internally has all previous turns.
- **History Replay Gap**
  - `ConversationActor::handle_load` simply returns `LoadSessionResponse { modes, models }`; no previous `SessionUpdate`s are sent (`codex-acp/src/conversation.rs:1585-1650`).
  - The conversation event loop only routes events to active submissions stored in `self.submissions`; replaying the rollout would immediately warn “unknown submission ID” and drop everything (`codex-acp/src/conversation.rs:1830-1840`). Result: clients must retain chat logs themselves.
- **Voice-dev State**
  - `AgentManager` only considers Claude resumable because `supportsSessionPersistence` is false for Codex (`packages/server/src/server/acp/agent-types.ts:33-67`).
  - `AgentPersistence` writes `agents.json` for app-started agents but currently stores only Claude’s session ids; Codex sessions disappear once the process exits (`packages/server/src/server/acp/agent-persistence.ts:1-89`).

## Next Steps (not implemented yet)
1. Install/run Codex ACP from PR #66 (or the author’s fork) with `--session-persist` so every session we start writes a manifest entry.
2. Extend our agent persistence to capture Codex session metadata (session id + rollout path + cwd + MCP servers) by reading Codex’s manifest immediately after `newSession` succeeds.
3. Flip Codex’s `supportsSessionPersistence` flag and teach `AgentManager` to call `/session/load` for persisted Codex agents, replaying history ourselves by parsing the saved rollout (mirroring our Claude fork).
4. Expose resume UI/UX for Codex agents started from the app; later we can explore listing Codex’s manifest directly for sessions started outside voice-dev.
