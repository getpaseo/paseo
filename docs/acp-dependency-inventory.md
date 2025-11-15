# ACP Dependency Inventory

Full list of the places where the app still depends on the ACP (Agent Client Protocol) stack and what the equivalent APIs/message contracts are in the new SDK `AgentManager` stack found in `packages/server/src/server/agent`. This is the baseline for the follow‑up refactors in `plan.md`.

## Summary (old vs. new)

| Area | Files w/ ACP coupling | ACP surface being used | AgentManager equivalent |
| --- | --- | --- | --- |
| Session orchestration | `packages/server/src/server/session.ts` | `./acp/agent-manager`, `AgentUpdate`, `AgentType`, `createAgentMcpServer`, `curateAgentActivity` + `generateAgentTitle` | Move to `server/agent/agent-manager` + `AgentRegistry`; consume `AgentManager.subscribe()` events (`agent_state` / `agent_stream`) and `AgentSnapshot`/`AgentStreamEvent`; use `AgentManager.runAgent`/`streamAgent`/`setAgentMode`/`respondToPermission`; rehost MCP tool surface on SDK clients |
| WebSocket transport | `packages/server/src/server/websocket-server.ts`, `packages/server/src/server/messages.ts` | Session still emits `agent_created`/`agent_initialized`/`agent_update` messages that wrap ACP `AgentUpdate` payloads | Define `agent_state` and `agent_stream` session events in `messages.ts`, forward `AgentSnapshot` + `AgentStreamEvent` to clients, and remove ACP‑specific envelopes |
| MCP tools | `packages/server/src/server/acp/mcp-server.ts`, `packages/server/src/server/session.ts` | MCP server calls `acp.AgentManager` helpers (`createAgent`, `wait_for_agent`, `getAgentActivity`, etc.) and serializes ACP `AgentNotification`s | Build `agent-mcp` on top of SDK `AgentManager` snapshots/streams (`AgentTimelineItem` for `curateAgentActivity`, `AgentPermissionRequest` for gating) and expose provider‑agnostic controls (`runAgent`, `getTimeline`, `respondToPermission`) |
| Title generator | `packages/server/src/services/agent-title-generator.ts`, `packages/server/src/server/acp/activity-curator.ts` | Takes `AgentUpdate[]` (ACP notifications) to derive activity summaries | Switch to `AgentTimelineItem[]` returned by `AgentManager.getTimeline()` and reuse the same prompt, so titles are based on SDK timeline events |
| Frontend session context + reducers | `packages/app/src/contexts/session-context.tsx`, `packages/app/src/types/stream.ts`, `packages/app/src/components/agent-stream-view.tsx`, `packages/app/src/components/tool-call-bottom-sheet.tsx`, `packages/app/src/types/shared.ts`, `packages/app/src/components/create-agent-modal.tsx` | Imports `AgentStatus`, `AgentUpdate`, `AgentNotification`, `RequestPermissionRequest`, and ACP agent type definitions; UI expects `agent_update` packets containing ACP `SessionNotification` deltas | Switch to shared SDK types exported via `@server/server/agent/...`: `AgentSnapshot`, `AgentManagerEvent`, `AgentStreamEvent`, `AgentPermissionRequest`, and provider definitions that come from `agent/providers`. `reduceStreamUpdate` should read `AgentTimelineItem` events instead of ACP deltas |

## Target AgentManager message contract

`packages/server/src/server/agent/agent-manager.ts` already exposes the SDK‑based contract we need to broadcast:

- `AgentManager.subscribe(callback, { agentId?, replayState? })` delivers `AgentManagerEvent`.
- `AgentManagerEvent` has **two** discriminants:
  - `agent_state`: full `AgentSnapshot` (id, provider, cwd, lifecycle status, capabilities, current/available modes, pending permissions, persistence handle, usage, last error). Snapshots should be sent whenever state changes and on initial subscription.
  - `agent_stream`: `{ agentId, event: AgentStreamEvent }` for incremental timeline data.
- `AgentStreamEvent` covers provider‑agnostic telemetry:
  - `thread_started`, `turn_started`, `turn_completed`, `turn_failed`.
  - `timeline` events where `item` is one of the normalized `AgentTimelineItem` entries (assistant text, reasoning, shell command, file change, MCP tool call, web search, todo list, error).
  - `provider_event` for raw SDK payloads (Codex JSONL / Claude SDK messages) when we need debugging.
  - `permission_requested` / `permission_resolved` which wrap the SDK `AgentPermissionRequest` / `AgentPermissionResponse`.

Going forward the server/websocket layer should expose only this contract to clients:

```ts
type AgentStateMessage = {
  type: "agent_state";
  payload: AgentSnapshotPayload; // serialized snapshot from messages.ts
};

type AgentStreamMessage = {
  type: "agent_stream";
  payload: {
    agentId: string;
    event: AgentStreamEventPayload; // serialized sdk event
    timestamp: string;
  };
};
```

These replace the ACP‑specific `agent_created`, `agent_initialized`, and `agent_update` payloads.

## Detailed inventory

### 1. Session orchestration (`packages/server/src/server/session.ts`)

- Imports `AgentManager` from `./acp/agent-manager`, `createAgentMcpServer` from `./acp/mcp-server`, ACP `AgentUpdate`/`AgentType`, and `curateAgentActivity`.
- Stores ACP `AgentUpdate[]` per agent (`agentUpdates` map) which feed title generation, MCP tooling, and UI hydration.
- Calls ACP‑only helpers: `subscribeToUpdates`, `initializeAgentAndGetHistory`, `getAgentUpdates`, `sendPrompt`, `createAgent`, `setSessionMode`, `respondToPermission`, `getCurrentMode`, etc.
- Emits ACP payloads downstream in `handleAgentUpdates` (`agent_update` websocket messages) and in `sendInitialState`.
- Hooks MCP by spinning `createAgentMcpServer({ agentManager })` and wiring ACP permission callbacks.
- Uses ACP title markers (`isTitleGenerationTriggered`, `markTitleGenerationTriggered`, `setAgentTitle`) that live on the ACP manager.

**AgentManager replacements**

- Replace `./acp/agent-manager` import with `./agent/agent-manager`. The SDK manager already supports `createAgent`, `resumeAgent`, `setAgentMode`, `respondToPermission`, and `streamAgent`.
- Instead of `subscribeToUpdates` pushing ACP notifications, call `agentManager.subscribe(event => ...)` and fan out `agent_state` / `agent_stream` events to the session emitter. Hydration can pull from `agentManager.listAgents()` + `agentManager.getTimeline(agentId)`.
- Replace `agentUpdates` cache with the SDK timeline: whenever we receive `agent_stream` events with `type: "timeline"` push them into the per‑agent stream map for UI and analytics. Use `agentManager.getTimeline(agentId)` for persistence/title generation.
- Title generation should call `generateAgentTitle(agentManager.getTimeline(agentId), info.cwd)` (see section 4) instead of `AgentUpdate[]`.
- MCP server should be instantiated from a new module that wraps SDK types (see section 3); the session should no longer pass ACP managers/tooling.

### 2. WebSocket transport + session messages (`packages/server/src/server/websocket-server.ts`, `packages/server/src/server/messages.ts`)

- WebSocket handler currently assumes `SessionOutboundMessage` includes ACP packets such as `agent_created`, `agent_initialized`, `agent_update`, and `agent_permission_*` shapes defined around `@server/server/acp/types`.
- `messages.ts` still exports `AgentUpdateMessageSchema`, `AgentInitializedMessageSchema`, and `AgentCreatedMessageSchema` that model ACP flows (agent bootstrap, update history, requestId echoes). `AgentPermissionRequest` payload uses `toolCall: z.any()` because it mirrors ACP's `RequestPermissionRequest`.

**AgentManager replacements**

- Introduce new `AgentStateMessageSchema` / `AgentStreamMessageSchema` in `messages.ts`, reuse the already defined `AgentSnapshotPayloadSchema` and `AgentStreamEventPayloadSchema` at the top of the file.
- Retire `agent_created`, `agent_update`, and `agent_initialized`; the new stack just replays snapshots + stream history.
- Update `Session` to emit `agent_state` (snapshot), `agent_stream` (single event), `agent_permission_request`/`agent_permission_resolved` that wrap `AgentPermissionRequest`/`AgentPermissionResponse` from the SDK.
- Ensure `session_state` messages include serialized `AgentSnapshotPayload` so the client can bootstrap agent lists without ACP types.

### 3. MCP server + tooling (`packages/server/src/server/acp/mcp-server.ts`, `packages/server/src/server/acp/activity-curator.ts`)

- Entire MCP surface (`create_coding_agent`, `wait_for_agent`, `send_agent_prompt`, `set_agent_session_mode`, etc.) depends on ACP `AgentManager`, `AgentNotification`, and the ACP timeline curator. The server fetches ACP updates via `agentManager.getAgentUpdates(agentId)` whenever it needs curated activity or permission state.
- ACP `curateAgentActivity()` expects `AgentUpdate[]`, so `wait_for_agent` and `get_agent_activity` can't interpret SDK timeline events.

**AgentManager replacements**

- Rebuild MCP tools to call the SDK manager:
  - `create_coding_agent` → `agentManager.createAgent({ provider, cwd, modeId, ... })`.
  - `wait_for_agent` → subscribe to `AgentManager.subscribe` and resolve when we see either a `permission_requested` or `turn_completed` / `turn_failed` event.
  - Activity endpoints should call `agentManager.getTimeline(agentId)` and run a new curator that understands `AgentTimelineItem`.
- Permission APIs can now use `AgentPermissionRequest` objects directly (they already include provider metadata and structured input).

### 4. Title generator (`packages/server/src/services/agent-title-generator.ts`)

- `generateAgentTitle(agentUpdates, cwd)` consumes ACP `AgentUpdate[]` and relies on `curateAgentActivity` (which itself walks ACP session notifications).
- ACP manager exposes `agent.titleGenerationTriggered` booleans; the new manager does not, so this logic must move into `Session`/`AgentRegistry`.

**AgentManager replacements**

- Change input signature to accept `(timeline: AgentTimelineItem[], cwd: string)` and implement a new curator that summarizes timeline entries (assistant messages, MCP tool calls, commands, etc.).
- Derive `activityContext` by slicing the last N timeline entries and formatting them into lines similar to the ACP version.
- Replace `isTitleGenerationTriggered`/`markTitleGenerationTriggered` with per‑session bookkeeping (e.g., store agent ids with generated titles in `Session` or `AgentRegistry`).

### 5. Frontend session context, reducers, and UI components

Files:

- `packages/app/src/contexts/session-context.tsx`
- `packages/app/src/types/stream.ts`
- `packages/app/src/types/shared.ts`
- `packages/app/src/components/agent-stream-view.tsx`
- `packages/app/src/components/tool-call-bottom-sheet.tsx`
- `packages/app/src/components/create-agent-modal.tsx`
- `packages/app/src/components/agent-sidebar.tsx`, `agent-list.tsx`, `active-processes.tsx`

**Current ACP dependencies**

- Imports `AgentStatus`, `AgentUpdate`, `AgentNotification`, and `AgentType` from `@server/server/acp/*`.
- Maintains `agentUpdates: Map<string, AgentUpdate[]>` to drive the stream reducer/hydration. `reduceStreamUpdate()` parses ACP `SessionNotification` deltas (`agent_message_chunk`, `tool_call`, etc.) and produces UI items.
- Tool call UI relies on ACP fields such as `payload.source === "acp"`, `data.rawInput`, `data.rawOutput`, `data.content[]`.
- Pending permissions reuse `RequestPermissionRequest` shapes from the ACP SDK.
- Agent creation modal loads ACP agent type definitions and mode lists.

**AgentManager replacements**

- Import shared SDK types from `@server/server/agent/agent-manager` and `agent-sdk-types`: use `AgentSnapshot` for list entries, `AgentLifecycleStatus` for status pills, and `AgentPermissionRequest` for permission dialogs.
- Replace `agentUpdates` map with `agentStreamState: Map<string, AgentStreamEvent[]>` or, more efficiently, store `StreamItem[]` keyed by agent and append whenever an `agent_stream` websocket message arrives.
- Update `reduceStreamUpdate` to consume `AgentStreamEvent` timeline entries:
  - `timeline.item.type === "assistant_message"` → assistant bubble.
  - `timeline.item.type === "reasoning"` → `thought`.
  - `timeline.item.type === "tool_call"` → `tool_call` entry with `payload.source === "agent"`, containing the normalized server/tool/status + input/output.
- Tool call bottom sheet should render the normalized timeline payload rather than ACP's nested `content`.
- Create agent modal should source provider/mode metadata from a new exported manifest (e.g., `packages/server/src/server/agent/providers`) instead of ACP spawn definitions.
- Permission cards should follow the new message contract: websocket `agent_permission_request` payload should contain the serialized `AgentPermissionRequest` (structured `input`, `suggestions`, metadata) rather than ACP's `toolCall` blob + option ids.

## Next steps

- Update `plan.md` task #1 as completed and link future work to this document so subsequent agents can implement the schema/API changes listed above.
