# Multi-daemon architecture

## Goals
- Keep the UI a union of all connected daemons; users shouldn't manually switch contexts to view data.
- Route every mutation (create/resume/import, file explorer, realtime) to the daemon associated with the agent/workspace.
- Make connectivity observable and resilient so screens gracefully handle offline daemons.

## Registry (what daemons exist?)
- Backed by `DaemonRegistryProvider` (`packages/app/src/contexts/daemon-registry-context.tsx`). Profiles live in AsyncStorage under `@paseo:daemon-registry` (legacy `@paseo:settings` is migrated) with fields: `id`, `label`, `wsUrl`, optional `restUrl`, timestamps, and optional metadata.
- React Query caches the registry (`staleTime/gcTime` Infinity) so reads are synchronous after first load. Writes update the cache and persist to storage.
- Removing the last entry seeds a local fallback profile so the UI never renders with an empty registry.

## Connections & session directory (what are we talking to?)
- `DaemonConnectionsProvider` (`packages/app/src/contexts/daemon-connections-context.tsx`) sits under the registry and tracks:
  - `connectionStates`: per-daemon discriminated union (`idle | connecting | online | offline | error`) with `lastError/lastOnlineAt`. Session providers call `updateConnectionStatus` so UI banners/settings stay accurate. Transitions are logged to console for observability.
  - A session accessor registry keyed by daemon id that feeds the session directory (see below). Entries expose `getSnapshot()`/`subscribe()` so any screen can read a daemon-constrained session without mounting its own provider.

## Session hosts & directory (how do we read/send data per daemon?)
- Root `_layout.tsx` defers all websocket management to `MultiDaemonSessionHost` and consumes session snapshots via `RealtimeProvider`, `useSessionDirectory`, and `useDaemonSession`.
- `MultiDaemonSessionHost` (`packages/app/src/components/multi-daemon-session-host.tsx`) spins up `SessionProvider`s for every daemon so all hosts stay hydrated simultaneously. These providers render `null`—they exist purely to own the websocket and publish state into the session directory.
- `SessionProvider` (`packages/app/src/contexts/session-context.tsx`):
  - Manages the websocket (`useWebSocket` with exponential backoff) and full session state (agents, streams, permissions, file explorer, provider models, drafts, queued messages, etc.).
  - Registers itself with `registerSessionAccessor(serverId, entry)` so the directory can serve `getSnapshot()` for that daemon. It also notifies directory listeners on every state change.
  - Persists per-daemon session snapshots to AsyncStorage (`@paseo:session-snapshot:<serverId>`) and hydrates them on mount so agent lists render while reconnecting.
  - Reports connection status changes back to `DaemonConnectionsProvider` (`online/connecting/offline/error`). Cleanup marks the daemon offline.
- Session directory access:
  - `useSessionDirectory()` flattens the accessor registry into `Map<serverId, SessionContextValue | null>`, triggering rerenders via provider notifications.
  - `useSessionForServer(serverId)` is a convenience wrapper.
    - `useDaemonSession(serverId, { suppressUnavailableAlert?, allowUnavailable? })` looks up the matching session from the directory; it throws `DaemonSessionUnavailableError` when missing (optionally suppressing the alert so callers can render inline placeholders).

## Routing & data-shaping rules (which daemon does a screen use?)
- Primary route shapes include both daemon and agent: `/agent/[serverId]/[agentId]`, with a compatibility shim `/agent/[id]` that resolves across daemons when old deep links omit the server id.
- Child routes (git diff, file explorer, diff viewers) also accept `serverId`; they guard with `useDaemonSession(..., { suppressUnavailableAlert: true })` and render connection-aware placeholders when offline.
- Agent screen uses `useDaemonSession(serverId, { suppressUnavailableAlert: true })` to scope data to the route daemon without mutating any global "active host" state.
- Aggregated views pull data from the session directory: `useAggregatedAgents` merges `session.agents` per daemon with labels from `connectionStates`. Inline navigation always passes the daemon id (`router.push({ pathname: "/agent/[serverId]/[agentId]", params: { serverId, agentId } })`).
- Mutations honor the target daemon:
  - Create/Resume/Import modals accept a `serverId` and block actions when that daemon is offline; successful creates/resumes navigate directly to the daemon returned by the payload without touching any global active-host concept.
  - Inline agent/file actions should use `useDaemonSession(resolvedServerId)` to ensure websocket sends route to the correct daemon without changing the global active session.

## When extending the system
- Fetch data for a specific daemon with `useDaemonSession(serverId)`; aggregated screens should compose data from `useSessionDirectory()`.
- For aggregated UIs, read from `useSessionDirectory()` and include `serverId` on any derived model you emit so navigation stays server-aware.
- Guard screens that can load while the target daemon is offline by catching `DaemonSessionUnavailableError` (or using `suppressUnavailableAlert`) and showing inline status instead of throwing alerts.
- When adding new routes, include `serverId` in the path/params and ensure any follow-up routes (file explorer, git diff, permissions) carry it through.
- Don't spin up manual websockets; mount another `SessionProvider` via `MultiDaemonSessionHost` if a background connection is needed.
