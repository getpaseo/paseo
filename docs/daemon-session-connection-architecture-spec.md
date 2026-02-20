# Daemon Session and Connection Architecture Specification

Status: Draft for implementation  
Owner: App + Server + Relay  
Last updated: 2026-02-20

## 1. Purpose

This spec defines the connection and session model across:

- Client app
- Relay
- Daemon server

The goal is to remove drift, make invalid states impossible, and move lifecycle decisions into explicit state machines outside React.

## 2. Scope

In scope:

- Session identity and lifetime
- Connection identity and lifetime
- Daemon client/transport ownership rules
- Host runtime manager behavior
- Relay responsibilities and protocol shape
- React integration boundaries
- UX loading contracts tied to machine state
- Required tests

Out of scope:

- Agent business logic (tool calls, model behavior)
- New UI visual design

## 3. Terminology

- `serverId`: stable daemon identity.
- `clientSessionKey`: stable client identity for one app install/profile. Persists across app restarts.
- `session`: daemon-side logical session associated with one `clientSessionKey`.
- `connection`: one physical socket path (direct or relay).
- `transport`: adapter that owns exactly one physical connection.
- `DaemonClient`: connection actor that owns one transport.
- `HostRuntimeManager`: per-host orchestrator that owns active and probe daemon clients.
- `probe client`: ephemeral daemon client used for latency/health probing only.

## 4. Non-Negotiable Invariants

1. Daemon session is keyed by `clientSessionKey`, not by transport.
2. Session survives disconnects and client restarts.
3. Client may open and close many connections over time for the same session.
4. `DaemonClient` owns exactly one transport; transport owns exactly one connection.
5. No separate ad-hoc `isConnected` state outside `DaemonClient` connection state.
6. Host runtime is the only source of truth for per-host connectivity in the app.
7. React does not coordinate connection lifecycle; React only renders machine snapshots and dispatches intents.
8. Probe clients never mutate active connection/session state.
9. No silent fallback identities. Missing required identity inputs are explicit errors.

## 5. Identity Model

## 5.1 Session Identity

- Required on every app->daemon connection (direct or relay): `clientSessionKey`.
- Daemon canonical external key:
  - `externalSessionKey = session:${clientSessionKey}`
- If a socket reconnects with same key, daemon reattaches to existing session.
- If socket disconnects, daemon keeps session alive for reconnect grace period.

## 5.2 Connection Identity

- Connection identity is per-socket and ephemeral.
- Connection identity is **not** the session identity.
- A transport instance never needs a separate protocol-level `connectionId` to identify itself on disconnect; instance ownership is local and explicit.

## 6. Component Responsibilities

## 6.1 DaemonClient

- Owns one transport instance.
- Exposes one connection machine.
- Supports clean terminal disposal.
- Must not be resurrected after disposal.
- Emits typed connection state changes.

## 6.2 Transport

- Owns one connection (WebSocket or equivalent).
- No multiplexing of multiple peer connections in one transport instance.
- Must expose `open`, `message`, `error`, `close`.
- Must enforce connect timeout and report typed failure reason.

## 6.3 HostRuntimeManager (per host)

- Owns per-host source of truth snapshot.
- Owns active `DaemonClient`.
- May create many probe clients in parallel; they are ephemeral and isolated.
- Can switch active client cleanly by:
  1. creating next client,
  2. subscribing,
  3. promoting snapshot generation,
  4. disposing previous client.
- Serializes transitions so stale async completions cannot patch current state.

## 6.4 Relay

- Relay routes bytes; it does not own logical session policy.
- Control plane reports connected client sessions.
- Data plane maps one daemon data peer per client session key.
- Relay may have many client sockets for same `clientSessionKey` concurrently.

## 6.5 Daemon Server

- Owns canonical session map keyed by `externalSessionKey`.
- Reattaches sockets to existing session on reconnect.
- Session continuity must work identically for direct and relay.

## 7. State Machines

## 7.1 DaemonClient Machine

States:

- `idle`
- `connecting`
- `connected`
- `disconnected`
- `disposed` (terminal)

Events:

- `CONNECT_REQUEST`
- `TRANSPORT_OPEN`
- `TRANSPORT_CLOSE(reason)`
- `TRANSPORT_ERROR(reason)`
- `CONNECT_TIMEOUT`
- `RECONNECT_TIMER`
- `DISPOSE`

Rules:

- `disposed` is terminal. All events except idempotent `DISPOSE` are ignored.
- `ensureConnected` is no-op in `disposed`.
- `connecting` has bounded timeout.
- Any disconnect clears in-flight waiters tied to that connection.

## 7.2 HostRuntimeManager Machine (per host)

States:

- `booting`
- `no_connections`
- `selecting_active_connection`
- `connecting_active`
- `online`
- `degraded` (active exists but not connected)
- `error`
- `stopped`

Context:

- `activeClientRef`
- `activeConnectionRef`
- `generation`
- `probeResults`
- `lastError`

Rules:

- All async side effects are generation-guarded.
- Snapshot only changes through machine transitions.
- Probe transitions cannot directly mutate active client state.
- Active switch is atomic with generation increment.

## 7.3 Agent Directory Sync Machine (per host session mirror)

States:

- `idle`
- `initial_loading`
- `ready`
- `revalidating`
- `error_before_first_success`
- `error_after_ready` (non-blocking)

Rules:

- After first success, errors are non-blocking.
- Sidebar skeleton/loading is tied to this machine, not ad-hoc React flags.

## 8. Relay Contract

## 8.1 Required Behavior

- Client connects with `clientSessionKey`.
- Relay control reports client session presence changes.
- Daemon establishes peer data connection per `clientSessionKey`.
- Multiple client sockets with same `clientSessionKey` are allowed; relay does not enforce single client socket.

## 8.2 Prohibited Behavior

- Enforcing one client socket per `clientId` when that `clientId` is used as session identity.
- Treating replacement of one socket as session replacement.

## 8.3 Protocol Notes

- Keep protocol focused on session keys and control events.
- Do not introduce protocol `connectionId` for disconnect ownership.
- Internal debug correlation IDs are allowed in logs, not required on the wire.

## 9. React Integration Contract

1. React reads runtime snapshots via external store subscription.
2. React never mirrors connection state into local `useState`/`useRef`.
3. React never calls connection lifecycle APIs except explicit user intent events.
4. Complex transition logic stays in machines/reducers, not effects.

## 10. UX Contract

## 10.1 Agent First Open

- If agent history has never been loaded for that agent in this session:
  - show full overlay spinner (centered, no text).
  - do not show "refreshing history" toast.
  - do not show empty "start chatting..." placeholder simultaneously.

## 10.2 Already Loaded Agent Revalidation

- Show existing toast for refresh/revalidation.
- Do not block with overlay.

## 10.3 Optimistic Agent Creation

- No loading overlay during optimistic create flow.

## 10.4 Errors

- Non-blocking indicator for revalidation failures after first successful load.

## 11. Retry and Timeout Policy

- Client connect timeout: bounded and explicit.
- Relay handshake timeout: bounded and explicit.
- Backoff retry for recoverable disconnects.
- Terminal `disposed` state disables retries.
- Retry reasons are typed and machine-readable.

## 12. Observability Requirements

Every connection/session event must log:

- `serverId`
- `clientSessionKey` (or hashed form)
- machine state transition (`from`, `to`, `event`)
- connection path (`direct`/`relay`)
- generation id (host runtime)
- typed reason/error code

## 13. Test Requirements

## 13.1 Unit

- `DaemonClient` transitions including terminal `disposed`.
- Host runtime generation guards prevent stale async writes.
- Agent directory sync machine transition coverage.

## 13.2 Integration

- Session continuity across disconnect/reconnect for direct.
- Session continuity across disconnect/reconnect for relay.
- Session continuity when switching active path direct <-> relay.
- Probe clients running in parallel do not affect active client/session.

## 13.3 E2E

- App can remain connected while switching network paths without losing agents.
- Sidebar and connection status converge correctly (no stuck connecting drift).
- First-open agent overlay contract and toast gating.

## 14. Migration Plan

1. Introduce and persist `clientSessionKey` on client.
2. Require session key for both direct and relay socket attach paths.
3. Update daemon session attach to use unified `externalSessionKey`.
4. Split relay daemon manager into:
   - control manager
   - per-peer connection instances
5. Remove single-client-socket relay enforcement for same session key.
6. Add `disposed` terminal state to `DaemonClient`.
7. Move remaining connection lifecycle logic from React effects into machines.
8. Add/expand tests before deleting legacy paths.
9. Delete legacy dual-state paths and fallback identity behavior.

## 15. Acceptance Criteria

- One canonical source of truth per host in runtime manager snapshot.
- No mirrored connection flags in React.
- No stuck `connecting` without timeout path.
- Session survives app restart and transport switch.
- Client can create/use many connections over time for same session.
- First-open loading UX follows overlay/toast contract exactly.

