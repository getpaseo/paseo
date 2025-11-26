# Multi-daemon architecture

## Goals
- Keep the UI a union of all connected daemons; users shouldn't manually switch contexts to view data.
- Route every mutation (create/resume/import, file explorer, realtime) to the daemon associated with the agent/workspace.
- Make connectivity observable and resilient so screens gracefully handle offline daemons.

## Registry (what daemons exist?)
- Backed by `DaemonRegistryProvider` (`packages/app/src/contexts/daemon-registry-context.tsx`). Profiles live in AsyncStorage under `@paseo:daemon-registry` (legacy `@paseo:settings` is migrated) with fields: `id`, `label`, `wsUrl`, optional `restUrl`, `autoConnect`, timestamps, and optional metadata.
- React Query caches the registry (`staleTime/gcTime` Infinity) so reads are synchronous after first load. Writes update the cache and persist to storage.
- Removing the last entry seeds a local fallback profile so the UI never renders with an empty registry.

## Active daemon + connection state (what are we talking to?)
- `DaemonConnectionsProvider` (`packages/app/src/contexts/daemon-connections-context.tsx`) sits under the registry and tracks:
  - `activeDaemonId`, persisted in AsyncStorage (`@paseo:active-daemon-id`) with a React Query mirror; it falls back to the first daemon in the registry if the stored id disappears.
  - `connectionStates`: per-daemon discriminated union (`idle | connecting | online | offline | error`) with `lastError/lastOnlineAt`. Session providers call `updateConnectionStatus` so UI banners/settings stay accurate. Transitions are logged to console for observability.
  - A session accessor registry keyed by daemon id + role (`primary | background`) that feeds the session directory (see below). Roles prevent duplicate connections when multiple hosts mount.
- `setActiveDaemonId` also emits `daemon_active_changed` analytics with the source of the change.

## Session hosts & directory (how do we read/send data per daemon?)
- Root `_layout.tsx` mounts a `SessionProvider` for the active daemon (keyed by `activeDaemon.id` so it remounts on switches) and wraps it with `RealtimeProvider`.
- `MultiDaemonSessionHost` (`packages/app/src/components/multi-daemon-session-host.tsx`) spins up **background** `SessionProvider`s for any `autoConnect` daemon that is neither active nor already registered as `primary`. These hosts hydrate data and keep the session directory warm without hijacking the active websocket.
- `SessionProvider` (`packages/app/src/contexts/session-context.tsx`):
  - Manages the websocket (`useWebSocket` with exponential backoff) and full session state (agents, streams, permissions, file explorer, provider models, drafts, queued messages, etc.).
  - Registers itself with `registerSessionAccessor(serverId, entry, role)` so the directory can serve `getSnapshot()` for that daemon. It also notifies directory listeners on every state change.
  - Persists per-daemon session snapshots to AsyncStorage (`@paseo:session-snapshot:<serverId>`) and hydrates them on mount so agent lists render while reconnecting.
  - Reports connection status changes back to `DaemonConnectionsProvider` (`online/connecting/offline/error`). Cleanup marks the daemon offline.
- Session directory access:
  - `useSessionDirectory()` flattens the accessor registry into `Map<serverId, SessionContextValue | null>`, triggering rerenders via provider notifications.
  - `useSessionForServer(serverId)` is a convenience wrapper.
    - `useDaemonSession(serverId?, { suppressUnavailableAlert? })` returns the active session when `serverId` is omitted, or the matching session from the directory; it throws `DaemonSessionUnavailableError` when missing (optionally suppressing the alert so callers can render inline placeholders).

## Routing & data-shaping rules (which daemon does a screen use?)
- Primary route shapes include both daemon and agent: `/agent/[serverId]/[agentId]`, with a compatibility shim `/agent/[id]` that resolves across daemons when old deep links omit the server id.
- Child routes (git diff, file explorer, diff viewers) also accept `serverId`; they guard with `useDaemonSession(..., { suppressUnavailableAlert: true })` and render connection-aware placeholders when offline.
- Agent screen sets `setActiveDaemonId(serverId, { source: "agent_route" })` so the root `SessionProvider`/`RealtimeProvider` match the daemon shown. Avoid swapping the active daemon for background actions; prefer `useDaemonSession` with an explicit `serverId` instead.
- Aggregated views pull data from the session directory: `useAggregatedAgents` merges `session.agents` per daemon with labels from `connectionStates`. Inline navigation always passes the daemon id (`router.push({ pathname: "/agent/[serverId]/[agentId]", params: { serverId, agentId } })`).
- Mutations honor the target daemon:
  - Create/Resume/Import modals accept a `serverId` and block actions when that daemon is offline; successful creates set the active daemon to the server returned by the payload before navigating.
  - Inline agent/file actions should use `useDaemonSession(resolvedServerId)` to ensure websocket sends route to the correct daemon without changing the global active session.

## When extending the system
- Fetch data for a specific daemon with `useDaemonSession(serverId)`; only use `useSession()` when the screen is scoped to the active daemon by design.
- For aggregated UIs, read from `useSessionDirectory()` and include `serverId` on any derived model you emit so navigation stays server-aware.
- Guard screens that can load while the target daemon is offline by catching `DaemonSessionUnavailableError` (or using `suppressUnavailableAlert`) and showing inline status instead of throwing alerts.
- When adding new routes, include `serverId` in the path/params and ensure any follow-up routes (file explorer, git diff, permissions) carry it through.
- Don't spin up manual websockets; mount another `SessionProvider` via `MultiDaemonSessionHost` if a background connection is needed.
