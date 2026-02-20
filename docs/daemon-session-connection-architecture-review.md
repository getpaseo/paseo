# Daemon Session and Connection Plan Review

Date: 2026-02-20
Plan reviewed: `docs/daemon-session-connection-architecture-spec.md`
Change set reviewed: current uncommitted workspace changes

## Verdict

Partial alignment.

The local changes implement major parts of the plan (runtime-owned host connectivity, disposed terminal state in `DaemonClient`, connect timeout path, relay multi-socket handling, and first-open UX gating). However, there are still blocking gaps against non-negotiable invariants and migration requirements.

## Findings

### 1. `clientSessionKey` is still optional, with silent fallback identity generation (Blocking)

Plan requirements impacted:
- Invariant 1: daemon session keyed by `clientSessionKey`
- Invariant 9: no silent fallback identities
- Migration steps 1-2: introduce/persist and require session key on direct + relay

Evidence:
- `packages/server/src/client/daemon-client.ts:148` keeps `clientSessionKey` optional.
- `packages/server/src/client/daemon-client.ts:373`-`packages/server/src/client/daemon-client.ts:377` silently generates `clt_${safeRandomId()}` when missing.
- `packages/app/src/hooks/use-daemon-client.ts:23`-`packages/app/src/hooks/use-daemon-client.ts:35` creates `DaemonClient` without providing `clientSessionKey`.
- `packages/app/src/utils/test-daemon-connection.ts:51`-`packages/app/src/utils/test-daemon-connection.ts:63` builds probe clients/URLs without `clientSessionKey`.

Impact:
- Session continuity is not uniformly guaranteed for all app->daemon paths.
- Identity fallback remains implicit instead of failing fast.

Coding-standards impact:
- Violates “prefer explicit error over fallback” for identity-critical behavior.

### 2. Host runtime async generation guards are incomplete for probe-side effects (High)

Plan requirements impacted:
- HostRuntime machine rule: all async side effects generation-guarded; stale async completions must not patch current state.

Evidence:
- `packages/app/src/runtime/host-runtime.ts:506`-`packages/app/src/runtime/host-runtime.ts:611` (`runProbeCycleNow`) performs async probes and then mutates snapshot/switches connection, but has no request-generation guard equivalent to `switchRequestVersion`.
- Generation checks exist only in switch flow (`packages/app/src/runtime/host-runtime.ts:627`-`packages/app/src/runtime/host-runtime.ts:764`).

Impact:
- Overlapping probe cycles can apply stale probe snapshots or stale switching decisions.

### 3. Directory sync machine is only partially modeled (Medium)

Plan requirements impacted:
- Section 7.3 machine shape (`initial_loading`, `revalidating`, `error_before_first_success`, `error_after_ready`).

Evidence:
- Runtime exposes `"idle" | "loading" | "ready" | "error"` only (`packages/app/src/runtime/host-runtime.ts:25`-`packages/app/src/runtime/host-runtime.ts:29`).
- “Revalidating” and both error phases are inferred indirectly via `hasEverLoadedAgentDirectory` rather than explicit machine states (`packages/app/src/runtime/host-runtime.ts:41`, `packages/app/src/runtime/host-runtime.ts:480`-`packages/app/src/runtime/host-runtime.ts:493`).

Impact:
- Current behavior can work, but the plan’s explicit state model and transition clarity are not fully realized.

### 4. React still triggers connection lifecycle operations outside explicit user intent (Medium)

Plan requirements impacted:
- React integration contract: React should not coordinate connection lifecycle except explicit user intent.

Evidence:
- `packages/app/src/components/multi-daemon-session-host.tsx:36`-`packages/app/src/components/multi-daemon-session-host.tsx:44` calls `runtime.ensureConnectedAll()` and `runtime.runProbeCycleNow()` on app foreground transitions.

Impact:
- Lifecycle policy remains partly driven by React effect orchestration.

### 5. Loading/refresh policy remains distributed across multiple hooks (Low)

Plan + coding-standards impact:
- Plan favors machine-driven, centralized state decisions.
- Coding standards call out “distributed decisions and conditional accretion”.

Evidence:
- Similar refresh/sync logic appears in:
  - `packages/app/src/hooks/use-sidebar-agents-list.ts`
  - `packages/app/src/hooks/use-all-agents-list.ts`
  - `packages/app/src/hooks/use-aggregated-agents.ts:45`-`packages/app/src/hooks/use-aggregated-agents.ts:81`
- `useAggregatedAgents.refreshAll` writes store directly without runtime sync state markers (`packages/app/src/hooks/use-aggregated-agents.ts:70`-`packages/app/src/hooks/use-aggregated-agents.ts:76`).

Impact:
- Greater risk of state drift and inconsistent loading semantics between surfaces.

## What is aligned well

- `DaemonClient` now has terminal `disposed` state and no-op `ensureConnected` in disposed state (`packages/server/src/client/daemon-client.ts`).
- Connect timeout path is explicit (`packages/server/src/client/daemon-client.ts:473`-`packages/server/src/client/daemon-client.ts:484`).
- Direct websocket URLs now support `clientSessionKey` (`packages/server/src/shared/daemon-endpoints.ts:64`-`packages/server/src/shared/daemon-endpoints.ts:77`).
- Relay and server now use session-style external keys and allow multi-socket client presence (`packages/server/src/server/relay-transport.ts:325`, `packages/server/src/server/websocket-server.ts`, `packages/relay/src/cloudflare-adapter.ts`).
- App-side host runtime is now the primary connectivity source for context/session wiring (`packages/app/src/contexts/daemon-connections-context.tsx`, `packages/app/src/components/multi-daemon-session-host.tsx`).
- Agent first-open vs revalidation UX behavior is substantially closer to plan (`packages/app/src/hooks/use-agent-screen-state-machine.ts`, `packages/app/src/screens/agent/agent-ready-screen.tsx`).

## Recommended next steps

1. Make `clientSessionKey` mandatory for app/runtime `DaemonClient` creation paths and throw explicit errors when missing.
2. Add probe-cycle generation tokens so stale probe results cannot update snapshots or trigger switches.
3. Promote directory sync to an explicit machine (or equivalent discriminated state) matching planned transition semantics.
4. Consolidate agent-directory refresh policy into one runtime-owned path and remove duplicate hook-level logic.
5. Add structured transition logging fields from section 12 (`serverId`, `clientSessionKey`/hash, `from/to/event`, `connection path`, `generation`, typed reason).
