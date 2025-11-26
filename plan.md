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

### 2. Remove Active/Primary/Auto-Connect Concepts
- [x] Remove the concept of "active daemon" from the UI and simplify to just "hosts".
  - Summary: Home/footer actions, create/import flows, and agent navigation now route directly via explicit host IDs with analytics/docs/aggregated list updates, verified with `npm run typecheck --workspace=@paseo/app`.
  - Context: `GlobalFooter`, the create/import modals, the agent screen, and the agent list previously read/write `activeDaemonId`, forcing a global active host before routing; they now rely on explicit host IDs instead.
- [x] Remove the concept of "primary daemon"—no default host for actions.
  - Eliminated the persisted `activeDaemonId`, flattened the session directory, and refactored `_layout`, realtime, settings, and agent UI to always resolve hosts explicitly so every host gets its own `SessionProvider`; verified via `npm run typecheck --workspace=@paseo/app`.
- [x] Remove the "auto-connect" toggle from host settings—hosts always auto-connect when added.
  - Removed the toggle from the host form so entries always auto-connect and verified with `npm run typecheck --workspace=@paseo/app`.
- [ ] Clean up any related state/UI that exposes these concepts to users.

### Review: No Silent Defaults
- [ ] Review the changes to ensure we didn't just replace "active daemon" with "first host" (e.g., `hosts[0]}`. The goal is explicit user choice, not a hidden default.

### 3. Simplify Settings Screen
- [ ] Remove the standalone "Test Connection" form/URL input at the top of settings.
- [ ] Keep the per-host "Test" button in each host row (already exists).

### 4. Transparent Connection Management
- [ ] When a host is added, the app auto-connects and keeps the connection alive.
- [ ] Users should never need to manually "connect" to a host—the app handles it.
- [ ] Remove any UI that asks users to "connect" before performing actions.

### 5. Fix Error Philosophy
- [ ] A stopped/disconnected host is NOT an error—don't show error states on home screen just because a host is offline.
- [ ] Only show errors when the user tries to interact with an agent whose host is stopped.
- [ ] Update connection banners/indicators to show neutral "offline" state instead of error styling.

### 6. Agent Creation Flow
- [ ] Remove reliance on "primary" or "active" daemon for agent creation.
- [ ] Require explicit host selection when creating an agent—user must choose where to deploy.
- [ ] Fix the contradictory error message "Daemon is online, connect to it before creating"—this should never appear.

### 7. Home Screen Agent List
- [ ] Remove grouping of agents by host—show a single flat list.
  - [ ] Each agent row displays its host name as metadata (badge, subtitle, etc.).
  - [ ] Sort agents by recent activity or alphabetically (not by host).
