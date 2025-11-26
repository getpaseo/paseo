# Multi-Daemon Production Rollout Plan

## Guiding Principles
- The app always reflects the union of every connected daemon—no manual switching to “see” data.
- Actions (create/resume agent, browse files, realtime tools) automatically route to the correct daemon based on the agent/workspace context.
- Connection health, loading states, and mutations are observable and resilient (React Query or equivalent).

## Workstreams & Tasks

### 1. Session Directory & Data Consistency
- [x] Rebuild `useSessionDirectory` so it stays in sync with realtime session state (agents, permissions, stream updates) instead of caching an accessor forever.
  - Added session-level subscriptions so the directory re-renders on daemon updates and ran `npm run typecheck` to verify.
- [x] Expose a lightweight subscription/API for background `SessionProvider`s so any change invalidates aggregated consumers without forcing rerenders of the main tree.
  - Added central session-directory listeners in the daemon connections context, had SessionProviders emit invalidations, updated `useSessionDirectory` to use the new API, and ran `npm run typecheck`.
- [x] Audit every consumer that still reaches for `useSession()` directly (AgentStreamView, AgentInputArea, file explorers, realtime, etc.) and ensure they receive the session instance that corresponds to the agent/daemon they’re operating on.
  - Agent detail UI now pulls daemon-scoped sessions via `useDaemonSession`, so sending messages, toggling modes, and inline file explorers all operate against the route’s `serverId` (see `packages/app/src/components/agent-input-area.tsx:72`, `packages/app/src/components/agent-stream-view.tsx:31`, `packages/app/src/components/agent-status-bar.tsx:6`, `packages/app/src/app/agent/[serverId]/[agentId].tsx:256`) and `npm run typecheck` passes.

### 2. Aggregated Agent Experience
- [x] Replace the home screen’s `agents.size` gate with `useAggregatedAgents`, render the merged list (grouped/sorted by daemon), and remove the daemon picker UI from the header.
  - Home now builds grouped daemon sections via `useAggregatedAgents`, `AgentList` renders each section with the correct serverId routing, the header exposes dedicated import/create buttons without manual daemon switching, and `npm run typecheck` passes.
  - When closing the agent action sheet we now clear the stored `serverId` so `useDaemonSession` falls back to the active daemon and the Home screen no longer crashes if that background daemon disconnects after a long-press.
- [x] Ensure all agent rows carry their `serverId` through navigation (Agent screen, diff viewer, file explorer, orchestrator) so every deep link includes `/agent/[serverId]/[agentId]`.
  - Annotated every agent snapshot with its daemon `serverId`, updated shared row components (`AgentList`, `AgentSidebar`, `ActiveProcesses`) to read it when navigating/deleting, and re-ran `npm run typecheck`.
- [x] Update stream detail routes (git diff, file explorer) to validate the daemon session from params and gracefully show status/loading/error states if the background session is unavailable.
  - Wrapped both routes in session guards that render connection-aware placeholders when the target daemon is offline/unavailable, moved the existing logic into gated child components, and re-ran `npm run typecheck` to verify.
- [x] Guard the main agent route when the requested daemon session is unavailable so deep links or quick daemon switches don't crash the screen.
  - Added a connection-aware guard around `/agent/[serverId]/[agentId]` that renders a friendly placeholder when the session is offline/unavailable and re-ran `npm run typecheck`.
- [x] Fix the agent screen dropdown positioning so we don't double-apply the safe-area offset and remove the leaked debug logging.
  - `packages/app/src/app/agent/[serverId]/[agentId].tsx:320-339` adds `insets.top` to `measureInWindow` coordinates (which already include the status bar) and emits `[Menu]` console logs on every open, so the action menu renders ~40px too low on notched devices and spams the JS console.
  - Removed the extra `insets.top` offset, cleaned up the `[Menu]` debug logs, and re-ran `npm run typecheck`.
- [x] Make inline file path navigation pick up the correct daemon id even when two daemons generate the same `agentId`.
  - Added `resolvedServerId` to the `handleInlinePathPress` dependency list in `packages/app/src/components/agent-stream-view.tsx:83-116`, so navigating after switching daemons now routes to the correct file explorer target; re-ran `npm run typecheck`.
- [x] Sync the active daemon context with the agent route so realtime/audio flows hit the same websocket as the rendered agent, even when arriving from a deep link.
  - `AgentScreen` looks up the requested session via `useDaemonSession` but never calls `setActiveDaemonId`, so opening `/agent/[serverB]/[agentId]` while daemon A is active leaves the global `SessionProvider`/`RealtimeProvider` pointed at A (see `packages/app/src/app/agent/[serverId]/[agentId].tsx:74-138`).
  - `AgentInputArea` forwards realtime/voice interactions through `useRealtime()` and the active `ws` (`packages/app/src/components/agent-input-area.tsx:656-744`), so with the mismatch above those commands get sent to daemon A instead of the daemon hosting the open agent.
  - Added a route-aware effect in `packages/app/src/app/agent/[serverId]/[agentId].tsx` that synchronizes `setActiveDaemonId` with the screen's `serverId` param so the root Session/Realtime providers follow deep links, and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Restore the legacy `/agent/[id]` route as a compatibility shim so old deep links (without a daemon id) keep working while we transition the UI.
  - Added `packages/app/src/app/agent/[id].tsx`, which scans the session directory for the requested agent, auto-redirects when there’s a single match, and lets the user choose when multiple daemons share that id; registered the screen in `_layout.tsx` and re-ran `npm run typecheck --workspace=@paseo/app`.
- [x] Keep background agent actions from swapping the active daemon just to open the action sheet or delete.
  - `AgentList` still called `setActiveDaemonId` on long-press and before deletion (`packages/app/src/components/agent-list.tsx:19-63`), so managing a background daemon’s agent on Home would tear down the active websocket/realtime session. Removed those calls and rely on `useDaemonSession` so the aggregated view no longer hijacks the global session for contextual actions.
- [x] Allow guarded screens to opt out of the `useDaemonSession` alert so offline placeholders don’t trigger duplicate system popups.
  - Added a `suppressUnavailableAlert` option to `useDaemonSession`, had Agent, Git diff, and File Explorer guards opt in so they only render their inline placeholders, and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Force the root `SessionProvider` to remount whenever the active daemon changes so session state never leaks between servers.
  - Added `key={activeDaemon.id}` in `_layout.tsx`, ensuring each daemon gets a fresh session tree so cached agents/permissions don’t show up under the wrong daemon while switching routes.

### 3. Agent Creation & Lifecycle Actions
- [x] Remove the server selector from the home header; inside the Create/Import modal replace the current “session swap” approach with an explicit `serverId` prop that simply determines which daemon receives the mutation.
  - Create/Import modals now accept a `serverId` prop, stop mutating the active daemon, and every caller (home screen, footer, agent view) passes the daemon id they’re operating against; ran `npm run typecheck`.
- [x] Prevent `useDaemonSession` from throwing during modal render when a daemon is offline—surface that state inside the UI (disabled create button + inline error) and keep the chip selection responsive.
  - Currently selecting a daemon chip whose session isn’t connected (e.g., auto-connect disabled or still initializing) crashes `CreateAgentModal` because `useDaemonSession` rethrows immediately; we need to gate the selection and show an inline “connect first” state instead of exploding.
  - Confirmed this is still happening: `CreateAgentModal` passes the selected `serverId` straight into `useDaemonSession` (`packages/app/src/components/create-agent-modal.tsx:233`), so tapping an offline daemon chip kills the modal before we can render error UI.
  - Updated `CreateAgentModal` to read sessions from the directory, block websocket actions while the target daemon is offline, surface a daemon availability warning, and disable create/import flows until the daemon connects; ran `npm run typecheck`.
- [x] When creating/resuming/cloning agents, route follow-up navigation and queued requests to the daemon returned in the success payload rather than assuming the active daemon changed.
  - `CreateAgentModal` now calls `setActiveDaemonId` with the server from the success payload before pushing the agent route, so the global `SessionProvider`/`RealtimeProvider` swaps to the correct daemon and realtime controls no longer stay bound to the previous server (see `packages/app/src/components/create-agent-modal.tsx:210-220` and `packages/app/src/components/create-agent-modal.tsx:845-864`); re-ran `npm run typecheck`.
- [x] Block Create/Import repo + snapshot fetches when the selected daemon is offline so we surface the availability error instead of spinning forever.
  - Guarded `requestRepoInfo`/`requestImportCandidates` with the daemon availability signal so offline sessions now surface `daemonAvailabilityError` immediately instead of issuing `ws.send`, then added the missing `sheetDeleteTextDisabled` style in `packages/app/src/components/agent-list.tsx` to clear the lingering `npm run typecheck --workspace=@paseo/app` failure.
- [x] Restore the Import Agent flow (modal entry, mutation wiring, navigation) without undoing the multi-daemon routing work from previous steps.
  - After reworking Home/Header and the modals, the import trigger disappeared and existing deep links no longer reach a functioning flow. Bring the Import CTA back (Home, footer, agent screen), ensure it accepts a daemon id, and verify the import mutation routes to the selected daemon without regressing the new server-aware navigation.
  - Rewired the import buttons across Home (header + empty state with deep-link auto open), the global footer, and the agent action menu so every trigger passes the correct daemon id into `ImportAgentModal`, and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Guard Create/Resume/Dictation actions when the active daemon is offline and no explicit daemon is selected.
  - The offline gate only ran for an explicitly chosen `serverId`, so opening the modal on an offline active daemon still fired create/resume/dictation websocket sends; `packages/app/src/components/create-agent-modal.tsx` now derives availability from the effective daemon id and requires an online websocket before enabling those flows.

### 4. Connection State & Persistence
- [x] Stop the Settings daemon list from firing “Daemon unavailable” alerts when background daemons are offline by reading session snapshots via `useSessionForServer` and only performing restart/test flows when a session is actually mounted.
  - Updated `packages/app/src/app/settings.tsx` to rely on `useSessionForServer` for both the active daemon and each `DaemonCard`, so offline entries no longer call `useDaemonSession` (which showed alerts) and `npm run typecheck` still passes.
- [x] Introduce React Query (or a similar observable store) around AsyncStorage-backed registries (`DaemonRegistryProvider`, `DaemonConnectionsProvider`, app settings) so callers get loading/error states without bespoke hooks.
  - Added `@tanstack/react-query` with a root provider, refactored the daemon registry, connections, and app settings to load/persist via cached queries (surfacing shared loading/error states) and verified everything with `npm run typecheck --workspace=@paseo/app`.
- [x] Add background reconnection + exponential backoff per daemon; surface “connecting/offline/last error” indicators in settings and home.
  - WebSocket sessions now retry with exponential backoff and feed precise status/error metadata into the daemon connection store, the home screen shows a connection health banner, settings display colored status badges plus last errors for every daemon, and `npm run typecheck --workspace=@paseo/app` passes.
- [x] Persist the last successful session snapshot per daemon so the UI can hydrate agent lists immediately while a websocket reconnects.
  - SessionProviders now hydrate agents/permissions/commands from the last stored `session_state` snapshot, persist new snapshots to AsyncStorage per daemon, and `npm run typecheck --workspace=@paseo/app` passes.
- [x] Standardize request/response handling behind a shared hook (React-Query style states for idle/loading/success/error, request dedupe, retries, timeouts) and document how daemon-facing components consume it.
  - Added `useDaemonRequest` with deduped execution, timeout/retry controls, and React Query-style metadata plus wrote `docs/daemon-request-hook.md` describing how daemon clients consume it; ran `npm run typecheck --workspace=@paseo/app`.
- [x] Replace ad-hoc websocket request flows (git info, permission responses, diff/file fetches, etc.) with the new hook so every async action exposes consistent status + cancellation semantics.
  - Adopted `useDaemonRequest` for repo-inspection modals, permission cards, git diff, and file explorer interactions (with inline loading/error states) and re-ran `npm run typecheck --workspace=@paseo/app`.

### 5. Performance & UX Polish
- [x] Ensure agent image attachments preserve MIME metadata and are base64 encoded before hitting the daemon.
  - `packages/app/src/contexts/session-context.tsx:1198` now accepts `{ uri, mimeType }` attachments and reads them via `expo-file-system`, and `packages/app/src/components/agent-input-area.tsx:140` forwards the stored metadata so queued sends no longer drop screenshots (`npm run typecheck` passes).
- [x] Profile the Create Agent modal—debounce expensive effects (e.g., provider model fetches) per server and prefetch metadata when daemons are idle to eliminate the visible lag when switching targets.
  - Added per-server debounce + cleanup around provider model requests, scheduled idle-time prefetch for online daemons via the session directory, and verified with `npm run typecheck --workspace=@paseo/app`.
- [x] Audit websocket usage so background `SessionProvider`s never duplicate connections for the active daemon (one live connection per daemon id).
  - Tracked session accessors by role, had background hosts register as `background`, filtered out daemons that already have a primary session before spinning up background connections, and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Enforce “impossible states are impossible” across UI/data models (strict typing, discriminated unions, exhaustive switches) so complex flows remain clean without relying on Expo E2E tests.
  - Tightened daemon connection state to a discriminated union with exhaustiveness checks, added an `assertUnreachable` helper for status switches, and re-ran `npm run typecheck --workspace=@paseo/app`.

### 6. Observability & Tooling
- [x] Add structured logging for daemon connection lifecycle (connect, error, auto-connect skip) so we can diagnose “multi daemon” issues from device logs.
  - Added connection state transition logs with daemon ids/labels plus auto-connect skip logs for disabled daemons, and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Emit analytics when users create/resume agents on background daemons, attempt actions while those daemons are offline, or switch default daemons—helps prioritize reconnection UX.
  - Added a centralized analytics helper, instrumented active-daemon switches plus background create/resume flows (including offline/blocked actions like dictation and import refresh), and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Document the architecture in `docs/multi-daemon.md` (registry, sessions, routing rules) so future contributors understand how to extend it.
  - Added a multi-daemon architecture guide detailing the registry, connection/session hosts, session directory access, routing rules, and extension guidelines (docs-only change; no tests needed).
- [x] Land the accumulated multi-daemon changes in source control with a clean commit (linted, type-checked, plan updated).
  - Fixed lint violations around guarded daemon screens, added an opt-in nullable `useDaemonSession`, reran `npm run lint --workspace=@paseo/app` (warnings only) and `npm run typecheck --workspace=@paseo/app`, and prepared the tree for a clean commit.

### Review
- [x] 2025-11-26 Reviewer sanity check for the recent multi-daemon rollout work.
  - Confirmed the new `useDaemonSession` hook, guarded Agent/Git Diff/File Explorer screens, and server-aware Create/Import flows align with the documented fixes; no regressions or missing follow-ups spotted, so no additional tasks were opened.
- [x] 2025-11-26 Reviewer follow-up on session isolation across daemons.
  - Found that the active `SessionProvider` kept its React state when switching daemons, so stale agents/permissions could leak between server contexts; fixed by keying the provider in `_layout.tsx` so the tree remounts on each daemon change.
- [x] 2025-11-26 Reviewer pass on provider model prefetch/perf work in CreateAgentModal.
  - Idle provider-model prefetch timers could still fire after a daemon was removed; cleared stale timers before scheduling background fetches so requests don't target deleted entries (`packages/app/src/components/create-agent-modal.tsx:1198`) and re-ran `npm run typecheck --workspace=@paseo/app`.
- [x] 2025-11-26 Reviewer pass on connection-state/SessionProvider role refactor.
  - Checked the new discriminated `ConnectionState`, role-aware session accessor registry, and `MultiDaemonSessionHost` filters to avoid duplicate websocket sessions; reran `npm run typecheck --workspace=@paseo/app` and didn't spot regressions or new follow-ups to open.
- [x] 2025-11-26 Reviewer pass on agent route daemon selection.
  - Deep links with unregistered daemon ids repeatedly forced `setActiveDaemonId`, remounting the root `SessionProvider` and flashing the missing-daemon screen; `/agent/[serverId]/[agentId]` now ignores unknown daemons and shows a clear unavailable state instead.
- [x] 2025-11-27 Reviewer pass on connection status UX.
  - Offline daemons were rendered with a muted tone via `getConnectionStatusTone`, hiding them in the connection banners; mapped offline to `warning` so settings/home surface disconnected daemons in amber (`packages/app/src/utils/daemons.ts`).
- [x] 2025-11-27 Reviewer fix for provider model fetching on the active daemon.
  - `CreateAgentModal` skipped provider model requests whenever no daemon was explicitly selected (active daemon fallback), so the model list never refreshed after changing the working directory. The effect now targets the effective daemon id instead of requiring `selectedServerId`, and `npm run typecheck --workspace=@paseo/app` passes (`packages/app/src/components/create-agent-modal.tsx`).
