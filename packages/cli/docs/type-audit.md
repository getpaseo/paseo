# CLI Type Audit (commands)

## Scope
- Audited `packages/cli/src/commands/**` for inline type/interface definitions.
- Checked `@getpaseo/server` exports from `packages/server/src/server/exports.ts`.
- Note: `packages/server/src/index.ts` does **not** exist in this repo; the package export entrypoint is `./src/server/exports.ts` per `packages/server/package.json`.

## Server Exports (current)
`packages/server/src/server/exports.ts` exports:
- `createPaseoDaemon`, `PaseoDaemon`, `PaseoDaemonConfig`
- `loadConfig`, `resolvePaseoHome`
- `createRootLogger`, `LogLevel`, `LogFormat`
- `loadPersistedConfig`, `PersistedConfig`
- `DaemonClient`, `DaemonClientConfig`, `ConnectionState`, `DaemonEvent`

No agent snapshot/timeline/permission/message types are exported.

## Findings by File

### `packages/cli/src/commands/agent/run.ts`
Inline types:
- `AgentSnapshot` (id/provider/cwd/createdAt/status/title)

Recommended server type:
- `AgentSnapshotPayload` from `packages/server/src/shared/messages.ts` (daemon client returns this shape). **Not exported** from `@getpaseo/server` today.

Notes:
- `AgentRunResult` is CLI output; no server type expected.

---

### `packages/cli/src/commands/agent/ps.ts`
Inline types:
- `AgentSnapshot` (id/provider/cwd/createdAt/status/title/archivedAt?)

Recommended server type:
- `AgentSnapshotPayload` (includes `archivedAt` and full snapshot fields). **Not exported**.

Notes:
- `AgentListItem` is CLI output; no server type expected.

---

### `packages/cli/src/commands/agent/send.ts`
Inline types:
- `AgentSnapshot` (id/provider/cwd/createdAt/status/title)

Recommended server type:
- `AgentSnapshotPayload`. **Not exported**.

Notes:
- `AgentSendResult` is CLI output; no server type expected.

---

### `packages/cli/src/commands/agent/inspect.ts`
Inline types:
- `AgentSnapshotLike` (snapshot fields + `lastUsage`, `capabilities`, `availableModes`, `pendingPermissions`)

Recommended server types:
- `AgentSnapshotPayload` (overall snapshot shape). **Not exported**.
- `AgentUsage` for `lastUsage`. **Not exported** (in `packages/server/src/server/agent/agent-sdk-types.ts`).
- `AgentCapabilityFlags` for `capabilities`. **Not exported**.
- `AgentMode` for `availableModes`. **Not exported**.
- `AgentPermissionRequest` for `pendingPermissions`. **Not exported**.

Notes:
- `pendingPermissions` uses `{ id, tool?: string }` but server type is `AgentPermissionRequest` with `{ name, kind, ... }`; current CLI projection is lossy and field names don’t match (`tool` vs `name`).
- `AgentInspect` and `InspectRow` are CLI output types.

---

### `packages/cli/src/commands/agent/logs.ts`
Inline types:
- `AgentStreamSnapshotMessage`
- `AgentStreamMessage`
- Timeline item shape in `formatTimelineItem` and `extractTimelineFrom*` helpers (`{ type: string; ... }`)

Recommended server types:
- `AgentStreamSnapshotMessage` from `packages/server/src/shared/messages.ts`. **Not exported**.
- `AgentStreamMessage` from `packages/server/src/shared/messages.ts`. **Not exported**.
- `AgentStreamEventPayload` from `packages/server/src/shared/messages.ts` (for `event` typing). **Not exported**.
- `AgentTimelineItem` from `packages/server/src/server/agent/agent-sdk-types.ts` (for timeline item shape). **Not exported**.

Notes:
- These are WebSocket message types; they should come from shared message definitions to avoid drift.
- `LogEntry` is CLI output.

---

### `packages/cli/src/commands/agent/mode.ts`
Inline types:
- `ModeListItem` (id/label/description)
- `SetModeResult` (agentId/mode)

Recommended server type:
- `ModeListItem` duplicates the shape of `AgentMode` (id/label/description) from `packages/server/src/server/agent/agent-sdk-types.ts`. **Not exported**.

Notes:
- `SetModeResult` is CLI output.

---

### `packages/cli/src/commands/daemon/start.ts`
Inline types:
- `StartOptions` (CLI flags)

Server type usage:
- CLI-only; no server type expected.

---

### `packages/cli/src/commands/daemon/status.ts`
Inline types:
- `DaemonStatus`
- `StatusRow`

Server type usage:
- CLI-only; no server type expected.

---

### `packages/cli/src/commands/daemon/restart.ts`
Inline types:
- `RestartResult`

Server type usage:
- CLI-only; no server type expected.

---

### `packages/cli/src/commands/daemon/stop.ts`
Inline types:
- `StopResult`

Server type usage:
- CLI-only; no server type expected.

## Gaps in `@getpaseo/server` Exports (needed for CLI cleanup)
To replace inline types in CLI commands, `@getpaseo/server` would need to export (directly or re-export):
- From `packages/server/src/shared/messages.ts`:
  - `AgentSnapshotPayload`
  - `AgentStreamEventPayload`
  - `AgentStreamMessage`
  - `AgentStreamSnapshotMessage`
  - (optionally) `AgentStateMessage`, `SessionStateMessage`, `SessionOutboundMessage` if CLI starts typing daemon event queues more strictly
- From `packages/server/src/server/agent/agent-sdk-types.ts`:
  - `AgentMode`
  - `AgentUsage`
  - `AgentCapabilityFlags`
  - `AgentPermissionRequest`
  - `AgentTimelineItem`

## Summary
Primary inline types that should become server imports are the agent snapshot/timeline/message/permission/mode shapes in `agent/*` commands. All are defined in server shared or agent SDK types today but are not exported through `@getpaseo/server`.
