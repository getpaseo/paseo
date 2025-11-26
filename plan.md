# Host Management UX Overhaul

## Completed Work (Summary)

The multi-daemon infrastructure is in place: session directory with daemon-scoped subscriptions, aggregated agent views, daemon-aware routing for agent/diff/file screens, React Query for connection state persistence, background reconnection with exponential backoff, `useDaemonRequest` for consistent async flows, structured logging, and architecture docs in `docs/multi-daemon.md`.

## Guiding Principles

- Hosts are always connected when added—no manual "connect" action, no toggles.
- A stopped host is not an error—it's just a state. Errors only surface when the user tries to interact with an agent whose host is stopped.
- No "active" or "primary" concepts—actions that need a host require the user to choose explicitly.
- The home screen shows a flat list of agents with host name as metadata, not grouped by host.

## Tasks

### 1. Rename "Daemon" to "Host" in UI
- [x] Rename all user-facing labels, messages, and UI text from "daemon" to "host" throughout the app.
  - Settings screen, connection banners, error messages, modals, etc.
  - Internal code can keep "daemon" terminology; this is UI-only.
  - Updated every user-facing string (settings, modals, placeholders, defaults) to say "host" and spot-checked via targeted searches; no automated tests were run.
  - Context: Remaining "daemon" labels in git diff, file explorer, and agent detail screens now say "host" (updated `packages/app/src/app/git-diff.tsx`, `file-explorer.tsx`, `agent/[id].tsx`, and `agent/[serverId]/[agentId].tsx`).
  - Review: Confirmed the agent redirect, file explorer, and git diff screens reflect the updated host wording with no lingering user-facing "daemon" strings.
  - Review follow-up: Git Diff screen still showed the selected host as "Server"; updated the meta labels to "Host" to keep UI text consistent (`packages/app/src/app/git-diff.tsx`).
  - Review follow-up (current): Found that the Git Diff header still surfaced the internal host ID instead of the friendly label; updated `GitDiffContent` to accept the computed `serverLabel` and verified via `npm run typecheck --workspace=@paseo/app`.
- [x] Review follow-up: Remove the lingering "Server" wording on the Settings add-host form and restart alert so everything says "host."
  - Context: The add-host input placeholder still reads "My Server" and the restart success alert title says "Server reachable" (`packages/app/src/app/settings.tsx:609`, `packages/app/src/app/settings.tsx:804-820`).
  - Updated placeholder from "My Server" to "My Host" and alert title from "Server reachable" to "Host reachable"; verified with `npm run typecheck --workspace=@paseo/app`.

### 2. Remove Active/Primary/Auto-Connect Concepts
- [x] Remove the concept of "active daemon" from the UI and simplify to just "hosts".
  - Summary: Home/footer actions, create/import flows, and agent navigation now route directly via explicit host IDs with analytics/docs/aggregated list updates, verified with `npm run typecheck --workspace=@paseo/app`.
  - Context: `GlobalFooter`, the create/import modals, the agent screen, and the agent list previously read/write `activeDaemonId`, forcing a global active host before routing; they now rely on explicit host IDs instead.
- [x] Remove the concept of "primary daemon"—no default host for actions.
  - Eliminated the persisted `activeDaemonId`, flattened the session directory, and refactored `_layout`, realtime, settings, and agent UI to always resolve hosts explicitly so every host gets its own `SessionProvider`; verified via `npm run typecheck --workspace=@paseo/app`.
- [x] Remove the "auto-connect" toggle from host settings—hosts always auto-connect when added.
  - Removed the toggle from the host form so entries always auto-connect and verified with `npm run typecheck --workspace=@paseo/app`.
- [x] Clean up any related state/UI that exposes these concepts to users.
  - Removed the legacy autoConnect state from daemon profiles and session hosts so every host hydrates automatically, refreshed the host-unavailable messaging/docs, and verified via `npm run typecheck --workspace=@paseo/app`.

### Review: No Silent Defaults
- [x] Review the changes to ensure we didn't just replace "active daemon" with "first host" (e.g., `hosts[0]}`). The goal is explicit user choice, not a hidden default.
  - Create/import modal now requires explicit host selection (no first entry default) and `useAggregatedAgents` no longer fabricates a host id via `connectionStates.keys().next()`; verified with `npm run typecheck --workspace=@paseo/app`.

### 3. Simplify Settings Screen
- [x] Remove the standalone "Test Connection" form/URL input at the top of settings.
  - Removed the global host selector/Test UI from `packages/app/src/app/settings.tsx` so configuration happens per-host within their cards/forms, and ran `npm run typecheck --workspace=@paseo/app`.
- [x] Keep the per-host "Test" button in each host row (already exists).
  - Verified `SettingsScreen` still renders the per-host Test CTA inside each `DaemonCard`, confirmed the button invokes `handleTestDaemonConnection`, and ran `npm run typecheck --workspace=@paseo/app`.

### 4. Transparent Connection Management
- [x] When a host is added, the app auto-connects and keeps the connection alive.
  - Added an AppState-aware reconnect path in `useWebSocket` so every background session automatically reconnects when the app becomes active again, keeping newly added hosts online without manual intervention; verified with `npm run typecheck --workspace=@paseo/app`.
- [x] Users should never need to manually "connect" to a host—the app handles it.
  - Reworded realtime, settings restart, and agent creation/import flows so they explain hosts reconnect automatically instead of asking users to connect manually; verified with `npm run typecheck --workspace=@paseo/app`.
- [x] Remove any UI that asks users to "connect" before performing actions.
  - Updated the host-unavailable alert, agent-not-found message, and settings restart failure copy to reassure that hosts reconnect automatically instead of asking users to connect manually; verified with `npm run typecheck --workspace=@paseo/app`.

### 5. Remove Host Status from Home Screen
- [x] Remove connection status banners/indicators from the home screen—settings is the place to check host health.
  - Context (review): `packages/app/src/app/index.tsx:47-144` still renders `connectionBanner` cards that surface per-host offline/error states directly on Home, so host health is still exposed outside Settings.
  - Review (2025-11-26): The `connectionIssues` filter includes `offline`, `connecting`, and `error` statuses, so any host that isn't `online` shows up in the banner. This contradicts the guiding principle that a stopped host is not an error.
  - Removed the connection status banner, associated state (`connectionIssues`, `statusColors`), styles, and unused imports (`useDaemonConnections`, `formatConnectionStatus`, `getConnectionStatusTone`, `Text`, `useUnistyles`) from `packages/app/src/app/index.tsx`; verified with `npm run typecheck --workspace=@paseo/app`.

### 6. Fix Error Philosophy
- [x] A stopped/disconnected host is NOT an error—don't show error states on home screen just because a host is offline.
  - Context (review): The home connection banner still prints destructive red `connectionError` text for every offline host entry, so the screen treats normal downtime as an error (`packages/app/src/app/index.tsx:123-140`).
  - Review (2025-11-26): The `connectionError` style unconditionally uses `theme.colors.destructive` (line 210-213) for `lastError` messages, even though `getConnectionStatusTone` correctly returns `warning` (amber) for `offline` status. The dot color respects the tone, but the error text does not.
  - Review (2025-11-26, follow-up): N/A—Task 5 removed the connection banner entirely, so no error styling appears on the home screen now.
- [x] Only show errors when the user tries to interact with an agent whose host is stopped.
  - Review (2025-11-26): Verified in `agent-list.tsx:148-163`—the action sheet shows a neutral "offline" message and disables the delete button; no error styling is used.
- [x] Update connection banners/indicators to show neutral "offline" state instead of error styling.
  - Review (2025-11-26): N/A—connection banners no longer exist on the home screen (removed in Task 5). Settings still shows host status but that's expected (settings is the place to check host health per the guiding principles).
- [x] Make the Git Diff offline/unavailable state neutral and stop instructing users to "connect" manually.
  - Context (update): `SessionUnavailableState` in `packages/app/src/app/git-diff.tsx` now uses neutral copy/styling that reassures users we auto-reconnect; verified with `npm run typecheck --workspace=@paseo/app`.
- [x] Update the File Explorer offline state to match the new philosophy (neutral messaging, no manual connect CTA).
  - Context (update): `FileExplorerSessionUnavailable` now shows the passive offline message with auto-reconnect guidance instead of destructive styles (`packages/app/src/app/file-explorer.tsx`).
- [x] Audit the agent detail flows for the same issue (offline agent screen + delete sheet) and replace the "connect this host" requirement with passive/offline messaging.
  - Context (update): `AgentSessionUnavailableState` and the delete sheet subtitle in `packages/app/src/components/agent-list.tsx` now explain that offline hosts reconnect automatically, removing the manual "connect" instruction.

### 7. Agent Creation Flow
- [x] Remove reliance on "primary" or "active" daemon for agent creation.
  - Review (2025-11-26): Verified that `create-agent-modal.tsx` no longer uses or falls back to any "active" or "primary" daemon; the modal requires explicit host selection and shows "Select a host before creating or importing agents" when none is chosen.
- [x] Require explicit host selection when creating an agent—user must choose where to deploy.
  - Review (2025-11-26): The `selectedServerId` state controls host selection, and `daemonAvailabilityError` blocks creation until a host is selected (`packages/app/src/components/create-agent-modal.tsx:336-342`).
- [x] Fix the contradictory error message "Daemon is online, connect to it before creating"—this should never appear.
  - Review (2025-11-26): Searched the codebase for this message pattern—no matches found. The message has been removed or never existed in the current code.

### 8. Fix Create Agent Modal Availability Check
- [x] The create modal shows "[Host Name] is offline. We'll reconnect automatically..." even when the host is online.
  - "Primary Daemon" is the host's label, not app copy—the availability check itself is broken.
  - Both hosts are online but the modal thinks they're offline and blocks creation.
  - Review (2025-11-26): Root cause identified at `packages/app/src/components/create-agent-modal.tsx:333-334`. The check `!session || selectedDaemonStatus !== "online" || !ws?.isConnected` has a timing issue:
    1. `session` comes from `useSessionForServer(selectedServerId)` which reads from `sessionAccessors`
    2. `sessionAccessors` is populated via `registerSessionAccessor` in a `useEffect` inside `SessionProvider`
    3. There's a timing window where `connectionStates` shows "online" but `session` is still null (SessionProvider hasn't run its registration effect yet)
    4. Additionally, checking both `selectedDaemonStatus !== "online"` AND `!ws?.isConnected` is redundant since `connectionStates` status is derived from `ws` in `SessionProvider`
  - Fix: Use `connectionStates` as the single source of truth for availability. Replace the check with `selectedDaemonStatus !== "online"` without requiring `session` to exist for availability purposes.
  - Completed: Changed `selectedDaemonIsUnavailable` to `selectedDaemonIsOffline` which only checks `selectedDaemonStatus !== "online"`. The `session` and `ws?.isConnected` checks were removed from the availability condition since `connectionStates` already reflects the true connection state. The `isTargetDaemonReady` check still requires `session` for actual operations (creating/resuming agents). Verified with `npm run typecheck --workspace=@paseo/app`.

### 9. Home Screen Agent List
- [x] Show a loading indicator while agents are being fetched (not while waiting for hosts to connect).
  - Don't block the home screen for offline hosts.
  - Handle edge cases: no hosts configured, no hosts connected, partial host connectivity.
  - Context (review): `HomeScreen` still flips directly to the "New/Import Agent" empty state whenever `aggregatedAgents` is empty, so offline hosts with agents appear as if there are zero agents and there's no neutral loading indicator (`packages/app/src/app/index.tsx:109-116`).
  - Review (2025-11-26): This task is still open. The home screen shows an empty state immediately if `aggregatedCount === 0`, with no distinction between "loading" and "truly empty." Offline hosts that may have agents will show zero agents until they reconnect.
  - Completed: Updated `useAggregatedAgents` to return `{ groups, isLoading }` where `isLoading` is true while the daemon registry loads or while hosts are `connecting` without a session yet. Updated `HomeScreen` to show an `ActivityIndicator` during loading, then either the agent list or empty state. Offline hosts don't block loading—only `connecting` hosts do.
- [ ] Remove grouping of agents by host—show a single flat list.
  - Context (review): `packages/app/src/components/agent-list.tsx:67-131` still maps `agentGroups` into host-specific sections with headers, so grouping hasn't been removed.
  - Review (2025-11-26): Still open. The `AgentList` component iterates over `agentGroups` and renders a section header (`sectionLabel`) per host.
  - [ ] Each agent row displays its host name as metadata (badge, subtitle, etc.).
    - Context (review): Agent rows only render cwd/provider/status/time (`packages/app/src/components/agent-list.tsx:87-125`), so there's no host metadata visible per row yet.
    - Review (2025-11-26): Still open. To flatten the list, host metadata must move into each row since section headers will be removed.
  - [ ] Sort agents by recent activity or alphabetically (not by host).
    - Context (review): `packages/app/src/hooks/use-aggregated-agents.ts:25-66` sorts sections by host registration order and only orders agents within a host, so we still bias the list ordering by host rather than recency across all agents.
    - Review (2025-11-26): Still open. The current `useAggregatedAgents` hook returns grouped data; it needs refactoring to return a flat, globally-sorted array.

### 9. Review: Git Diff Metadata Cleanup
- [x] Remove the now-unused `routeServerId` prop from `GitDiffContent` (`packages/app/src/app/git-diff.tsx:84-104`) so we aren't plumbing dead state through the component after switching to `serverLabel`.
  - Context: Deleted the redundant prop/const and updated `GitDiffContent` to rely solely on `serverLabel`, removing the final host-id plumbing that was no longer used anywhere in the component (`packages/app/src/app/git-diff.tsx`).

---

## Review Summary (2025-11-26)

**Completed:**
- Tasks 1–7 are complete
- Task 9 loading indicator is complete
- Internal code correctly uses "daemon" terminology while UI says "host"
- Connection banners removed from home screen
- Error philosophy fixed for Git Diff, File Explorer, and agent action sheets
- Settings screen retains host status indicators (correct per guiding principles)
- Typecheck passes

**Remaining Work:**

### Task 8: Create Agent Modal Availability Check
The modal incorrectly shows hosts as offline when they're actually online. Root cause is a timing issue where `session` is null during the brief window between `connectionStates` updating and `SessionProvider` registering its session accessor.

**Fix required in `packages/app/src/components/create-agent-modal.tsx`:**
- Line 333-334: Change `selectedDaemonIsUnavailable` to only check `selectedDaemonStatus !== "online"`
- Don't require `session` to exist for the availability check—`session` is only needed for actual operations
- The availability UX should use `connectionStates` as single source of truth

### Task 9: Home Screen Agent List (partial)
The loading indicator is complete. Still need:
1. **Flat list**: `AgentList` still renders sections with host headers via `agentGroups.map()`
2. **Host metadata per row**: Agent rows don't show which host they belong to (required once sections are removed)
3. **Global sorting**: Agents are still grouped by host order; need to flatten and sort by recency across all hosts

**Files to modify for Task 9:**
- `packages/app/src/hooks/use-aggregated-agents.ts` — return flat array sorted by activity
- `packages/app/src/components/agent-list.tsx` — remove section headers, add host badge to rows
