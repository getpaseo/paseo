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
- [ ] Remove connection status banners/indicators from the home screen—settings is the place to check host health.
  - Context (review): `packages/app/src/app/index.tsx:47-144` still renders `connectionBanner` cards that surface per-host offline/error states directly on Home, so host health is still exposed outside Settings.

### 6. Fix Error Philosophy
- [ ] A stopped/disconnected host is NOT an error—don't show error states on home screen just because a host is offline.
  - Context (review): The home connection banner still prints destructive red `connectionError` text for every offline host entry, so the screen treats normal downtime as an error (`packages/app/src/app/index.tsx:123-140`).
- [ ] Only show errors when the user tries to interact with an agent whose host is stopped.
- [ ] Update connection banners/indicators to show neutral "offline" state instead of error styling.
- [x] Make the Git Diff offline/unavailable state neutral and stop instructing users to "connect" manually.
  - Context (update): `SessionUnavailableState` in `packages/app/src/app/git-diff.tsx` now uses neutral copy/styling that reassures users we auto-reconnect; verified with `npm run typecheck --workspace=@paseo/app`.
- [x] Update the File Explorer offline state to match the new philosophy (neutral messaging, no manual connect CTA).
  - Context (update): `FileExplorerSessionUnavailable` now shows the passive offline message with auto-reconnect guidance instead of destructive styles (`packages/app/src/app/file-explorer.tsx`).
- [x] Audit the agent detail flows for the same issue (offline agent screen + delete sheet) and replace the "connect this host" requirement with passive/offline messaging.
  - Context (update): `AgentSessionUnavailableState` and the delete sheet subtitle in `packages/app/src/components/agent-list.tsx` now explain that offline hosts reconnect automatically, removing the manual "connect" instruction.

### 6. Agent Creation Flow
- [ ] Remove reliance on "primary" or "active" daemon for agent creation.
- [ ] Require explicit host selection when creating an agent—user must choose where to deploy.
- [ ] Fix the contradictory error message "Daemon is online, connect to it before creating"—this should never appear.

### 7. Home Screen Agent List
- [ ] Show a loading indicator while agents are being fetched (not while waiting for hosts to connect).
  - Don't block the home screen for offline hosts.
  - Handle edge cases: no hosts configured, no hosts connected, partial host connectivity.
  - Context (review): `HomeScreen` still flips directly to the "New/Import Agent" empty state whenever `aggregatedAgents` is empty, so offline hosts with agents appear as if there are zero agents and there's no neutral loading indicator (`packages/app/src/app/index.tsx:105-161`).
- [ ] Remove grouping of agents by host—show a single flat list.
  - Context (review): `packages/app/src/components/agent-list.tsx:67-131` still maps `agentGroups` into host-specific sections with headers, so grouping hasn't been removed.
  - [ ] Each agent row displays its host name as metadata (badge, subtitle, etc.).
    - Context (review): Agent rows only render cwd/provider/status/time (`packages/app/src/components/agent-list.tsx:87-125`), so there's no host metadata visible per row yet.
  - [ ] Sort agents by recent activity or alphabetically (not by host).
    - Context (review): `packages/app/src/hooks/use-aggregated-agents.ts:25-66` sorts sections by host registration order and only orders agents within a host, so we still bias the list ordering by host rather than recency across all agents.

### Review: Git Diff Metadata Cleanup
- [x] Remove the now-unused `routeServerId` prop from `GitDiffContent` (`packages/app/src/app/git-diff.tsx:84-104`) so we aren't plumbing dead state through the component after switching to `serverLabel`.
  - Context: Deleted the redundant prop/const and updated `GitDiffContent` to rely solely on `serverLabel`, removing the final host-id plumbing that was no longer used anywhere in the component (`packages/app/src/app/git-diff.tsx`).
