# Agent Architecture Refactor Proposal

## Current State Analysis

### AgentSnapshot Usage

| Location | Purpose |
| --- | --- |
| `src/server/agent/agent-manager.ts:231-247` | `getAgent` / `listAgents` expose `AgentSnapshot` copies generated via `toSnapshot`. |
| `src/server/session.ts:534-577, 1130-1145` | Session broadcasts snapshots to clients (`forwardAgentState`, `buildAgentPayload`). |
| `src/server/agent/agent-registry.ts:138-185` | `applySnapshot` is driven by snapshots (via `attachAgentRegistryPersistence`). |
| `src/server/persistence-hooks.ts:23-35` | Persistence hook subscribes to `agent_state` and forwards snapshots. |
| `src/server/agent/mcp-server.ts:12-452` | MCP endpoints serialize snapshots for diagnostics/listing. |
| `src/server/messages.ts:19-338` | `AgentSnapshotPayload` and `serializeAgentSnapshot` expect snapshots. |
| Tests (`src/server/persistence-hooks.test.ts`, `src/server/agent/agent-registry.test.ts`) | Fabricate snapshots as fixtures. |

### Impacted Areas

- `AgentManager` snapshot creation & event emission.
- Session serialization (`buildAgentPayload`, `forwardAgentState`).
- Registry persistence (`applySnapshot`, tests).
- MCP server responses.
- Messaging schema & helper utilities.

### Why AgentSnapshot Existed

It attempted to provide a JSON-friendly view stripped of internal handles (e.g., `AgentSession`, `pendingRun`). In practice it duplicates the data model, omits config (requiring `recordConfig`), and forces redundant copies. All downstream consumers just serialize the snapshot immediately, so it adds complexity without real protection.

## Proposed Design

### Single Source of Truth

Introduce a discriminated union for `ManagedAgent` that encodes lifecycle-specific invariants:

```ts
type ManagedAgent =
  | { lifecycle: "initializing"; pendingRun: null; /* ... */ }
  | { lifecycle: "running"; pendingRun: AsyncGenerator<AgentStreamEvent>; /* ... */ }
  | { lifecycle: "idle"; pendingRun: null; /* ... */ }
  | { lifecycle: "error"; pendingRun: null; lastError: string; /* ... */ }
  | { lifecycle: "closed"; session: null; pendingRun: null; /* ... */ };
```

Fields include the live `AgentSession`, normalized config (`AgentSessionConfig`), timelines, permissions map, timestamps, persistence handles, etc. Impossible states (e.g., `pendingRun` non-null while lifecycle `"idle"`) become unrepresentable.

### Pure Transformation Functions

1. **Persistence Projection**
   ```ts
   function toStoredAgentRecord(agent: ManagedAgent, options?: { title?: string | null }): StoredAgentRecord
   ```
   Copies provider, cwd, ISO timestamps, lifecycle status, `lastModeId`, complete config (`modeId`, `model`, `extra`), persistence handle, title metadata.

2. **Client Payload Projection**
   ```ts
   function toAgentPayload(agent: ManagedAgent, options?: { title?: string | null }): AgentSnapshotPayload
   ```
   Converts dates to ISO strings, normalizes pending permissions map to an array, includes safe config/model fields for UI, hides `AgentSession` reference.

3. **Additional helpers**
   Reuse the same projections for MCP responses, diagnostics, etc. The functions are deterministic and easy to test.

### Unified Persistence Flow

- Remove `AgentSnapshot` and `recordConfig`.
- `AgentManager.subscribe` emits `ManagedAgent` references (or read-only copies) on `agent_state`.
- `attachAgentRegistryPersistence` now calls `toStoredAgentRecord` and writes the result. This single path handles both lifecycle and config data atomically.
- Tests rely on the pure projection functions instead of crafting ad-hoc snapshots.

### Lazy Initialization Strategy

- `restorePersistedAgents` still reads `StoredAgentRecord` entries with full config populated by the projection.
- Lazy `ensureAgentLoaded` uses the stored record to resume the agent on demand; no special-case status bootstrapping required.
- When an agent is resumed/created, `AgentManager` emits `agent_state` events with the live `ManagedAgent`, ensuring persistence is updated immediately before any other code touches the registry.

### Client Communication

- Session and MCP server call `toAgentPayload` before emitting events.
- `AgentSnapshotPayload` remains the wire-format schema, but it’s derived directly from `ManagedAgent`.
- Clients continue to receive the same data shape (with potential additions, e.g., config info) without intermediate snapshot objects.

## Risk Assessment

| Risk | Mitigation |
| --- | --- |
| All consumer APIs expect `AgentSnapshot`. | Update type signatures and provide pure projection helpers; TypeScript will flag missing updates. |
| Accidentally exposing mutable internal state. | Projections must deep-clone arrays/maps; optionally expose read-only `ManagedAgentView` wrappers. |
| Persistence logic mistakes. | Add dedicated unit tests for `toStoredAgentRecord`; compare outputs with existing fixtures. |
| Client payload regressions. | Snapshot serialization tests (`serializeAgentSnapshot`, session tests) must be updated to use the new helper. |
| Integration behavior (lazy init/status updates). | Manual QA and e2e tests verifying “open agent after restart” scenarios. |

### Test Coverage

- Existing registry + persistence-hook tests already exercise serialization; they must be ported to the new helpers.
- Need new tests for `toStoredAgentRecord` and `toAgentPayload` to validate field-level correctness.
- Re-run session/MCP/e2e tests to ensure agent cards, timelines, and lazy loading still function.

### Migration Strategy

- Breaking change is acceptable (server + client change together). `agents.json` schema stays identical; only the producer path changes.
- Local migrations not required; new code overwrites entries with full config automatically.

## Implementation Plan

1. **Introduce transformation helpers & tests**
   - Implement `toStoredAgentRecord` and `toAgentPayload`.
   - Add unit tests covering all lifecycle variants and edge cases (pending permissions map, optional fields).

2. **Refactor AgentManager emissions**
   - Remove `AgentSnapshot` type and `toSnapshot`.
   - Update `subscribe`, `getAgent`, `listAgents`, and event dispatchers to pass `ManagedAgent`.
   - Ensure consumers cannot mutate returned references (clone or freeze if necessary).

3. **Update consumers**
   - **Registry:** `applySnapshot` now accepts `ManagedAgent` and uses `toStoredAgentRecord`. Delete `recordConfig`.
   - **Session/MCP:** call `toAgentPayload` when broadcasting to clients; update serialized types.
   - **Messages schema:** keep `AgentSnapshotPayload` but note it’s derived from `ManagedAgent`.

4. **Cleanup**
   - Remove `AgentSnapshot` definitions, serialization helpers, and obsolete code paths/tests.
   - Ensure `AgentRegistry` no longer imports `AgentSnapshot`.

5. **Validation**
   - Run `npm run test agent-registry`, persistence hook tests, session tests.
   - Manual QA: create agent → verify `agents.json` includes status & config; restart server → open agent → ensure UI shows “idle” immediately.

## Validation Plan

- **Unit Tests**
  - `toStoredAgentRecord` and `toAgentPayload` coverage (all lifecycle states, optional fields, config propagation).
  - Update registry/persistence tests to use `ManagedAgent` fixtures.

- **Integration Tests**
  - Session → client agent list (`SessionContext` expectations) to ensure payload format.
  - Lazy init/resume scenario (open agent after restart without manual refresh).
  - MCP “list agents” command returning full info.

- **Manual Verification**
  - Create agents with various configs/modes; inspect `agents.json`.
  - Restart server; verify UI cards show accurate status and accept prompts immediately.
  - High-load scenario: multiple agents running concurrently to ensure no races in persistence.

This refactor removes redundant abstractions, consolidates persistence into deterministic pure functions, and keeps `ManagedAgent` as the authoritative state—from which every other representation (disk, UI, MCP) is derived.***
