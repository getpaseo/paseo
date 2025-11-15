# Verification Status

## Automated Suites

### Lint (`@voice-dev/app`)
- Command: `npm run lint --workspace=@voice-dev/app`
- Result: **Failed** — Expo lint surfaced 1 error and 53 warnings.
- Key issues:
  - `packages/app/src/components/agent-sidebar.tsx:77` calls `useSharedValue` conditionally (violates hooks order) and blocks the lint run.
  - Numerous `react-hooks/exhaustive-deps` and unused symbol warnings across `agent/[id].tsx`, `file-explorer.tsx`, `conversation-selector.tsx`, `create-agent-modal.tsx`, `volume-meter.tsx`, etc.
  - Styling/typing lint rules (array types, unused imports/vars) in `agent-input-area.tsx`, `agent-activity.ts`, `stream.ts`, and more.

### Typecheck (`@voice-dev/server`)
- Command: `npm run typecheck --workspace=@voice-dev/server`
- Result: **Failed**
- Notable errors:
  - `packages/server/src/server/index.ts:179` — parser expects a closing brace, so the entry file currently has unmatched braces.
  - `packages/server/src/server/agent/agent-manager.ts:294` — `undefined` cast to `AgentStreamEvent` is rejected.
  - `packages/server/src/server/messages.ts:35` and `:163` — zod schemas for `AgentMode` and `AgentStreamEvent` don't align with the strongly typed definitions.

### Typecheck (`@voice-dev/app`)
- Command: `npm run typecheck --workspace=@voice-dev/app`
- Result: **Failed**
- Notable errors:
  - `packages/app/src/app/file-explorer.tsx:179` mixes `??` and `||` without parentheses.
  - `packages/app/src/components/create-agent-modal.tsx` — multiple references to the global `JSX` namespace aren't recognized, and certain props fail to satisfy `StyleProp<ViewStyle>` (e.g., line 503).
  - Server type errors bubbled into the app build via monorepo references to `packages/server`.

### Unit Tests (`@voice-dev/server`)
- Command: `npm run test --workspace=@voice-dev/server`
- Result: **Inconclusive** — `vitest run` never completed (hung for >5 minutes with no suite output). Needs investigation into leaked async handles or long-running tests before the suite can pass.

### Integration Tests (`@voice-dev/server`)
- Command: `npm run test:e2e --workspace=@voice-dev/server`
- Result: **Failed immediately**
- Playwright attempted to boot the dev web server (`node --watch --import tsx src/server/index.ts`), but the watcher hit `EMFILE: too many open files` and subsequently `EPIPE` when the process crashed. The e2e runner cannot start until the dev server can launch without exhausting file descriptors.

## Manual Verification Checklist (Staged)

- **Multi-agent sessions** — Not run. Planned steps: start the backend via `npm run dev --workspace=@voice-dev/server`, launch the Expo app (`npm run dev:app`), connect to the session list, create at least two agents through `CreateAgentModal`, spawn a session containing both, and verify AgentManager timelines stream correctly for each agent.
- **Permission prompts** — Not run. Planned steps: while connected to a live session, trigger a tool that requires user approval (e.g., MCP file access) and confirm that the permissions sheet surfaces in the client, can be approved/denied, and that the server relays the resulting `agent_permission` events.
- **Plan mode flows** — Not run. Planned steps: initiate Plan mode from the client UI, ensure plan creation events reach the server, add/edit/remove plan items, and confirm the frontend reflects streaming updates from AgentManager.
- **Resume flow** — Not run. Planned steps: run an agent turn to produce snapshots, stop both server and client, restart them, rejoin the same session, and verify that persisted AgentManager timelines hydrate automatically without issuing manual `initialize_agent_request`.
