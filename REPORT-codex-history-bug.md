# Codex history missing after daemon restart

## Root cause
- Codex MCP history loader only searched a single session root derived from `CODEX_SESSION_DIR` (or metadata), then stopped.
- In practice the Codex CLI still writes rollouts under the default `~/.codex/sessions` even when a custom session dir is present in metadata, so the lookup could miss the real rollout file after a daemon restart.
- When the lookup fails, `loadPersistedHistoryFromDisk()` returns an empty timeline, so `streamHistory()` yields nothing and the UI shows an empty conversation.

## Fix
- Prefer a persisted rollout path if present, but fall back to scanning the default Codex sessions directory when the preferred root has no rollout file.
- Allow history lookup to use `conversationId` when `sessionId` is missing so resume still works.
- Persist `codexSessionDir` so future resumes can try the same root first, but always fall back to the default root if it does not contain the rollout file.

## Files touched
- `packages/server/src/server/agent/providers/codex-mcp-agent.ts`
