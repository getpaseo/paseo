# Agent Client RPC + Wait Semantics Refactor (Proposal)

Status: proposal for review (no implementation yet)

## Goals

- Make all “fetch agent(s)” flows real RPCs (no fire-and-forget + sleep).
- Remove the expectation that the `DaemonClient` owns agent state; callers (CLI, app) own state.
- Move agent ID/prefix resolution to the server (clients should not fetch all agents just to resolve a prefix).
- Make `sendAgentMessage` an RPC so `await sendAgentMessage()` has a concrete, reliable guarantee.
- Make waiting deterministic via a server RPC:
  - return immediately if the agent is already idle/error, or has pending permissions
  - otherwise wait until idle/error/permission or timeout
- Keep label filtering (existing behavior) for list fetches and subscriptions.
- No backwards compatibility (protocol, client API, CLI behavior can break).

## Current Problems Observed

### 1) CLI commands fetch the full agent list frequently

Many CLI commands do:

1. `client.requestAgentList()` (fire-and-forget)
2. `setTimeout(500ms)`
3. `client.listAgents()` (reads client-side cache)
4. Resolve a prefix locally

This is wasteful and races (500ms is not a guarantee).

### 2) Client-side agent cache + message queue create confusing semantics

`DaemonClient` maintains:

- `agentIndex` (populated from `agent_list` and `agent_update`)
- `messageQueue` (replay buffer, also used for “infer transitions”)

This blurs responsibilities: the “transport client” becomes a state manager.

### 3) `waitForFinish` requires observing “running” before considering “idle” finished

`waitForFinish` currently uses a `sawStart` guard (only flips after a `running` update is observed in the current client’s stream).

This prevents a race (“return old idle from before a run started”) but introduces another:

- A new `paseo wait` process can attach after the run is already finished (idle) and never observe `running`, so it waits until timeout.

### 4) `sendAgentMessage` is fire-and-forget (no server ack)

`sendAgentMessage` resolves after the message is sent over the websocket, not after the server has processed it and started a run.

Therefore `await sendAgentMessage()` does **not** guarantee the agent is running server-side.

## High-Level Design Decisions

### A) Everything becomes an RPC (requestId → response)

We remove fire-and-forget “request something and later hope it arrived” patterns.

### B) Callers own agent state

The client should not be responsible for maintaining a canonical agent list in-memory. The app can store agents in Zustand; the CLI can fetch what it needs for each command.

The client remains:

- a typed transport
- an RPC wrapper
- a subscription/event emitter

### C) Server-side ID resolution

Any place the server accepts an agent identifier should accept:

- full ID, or
- short prefix (only if it uniquely matches exactly one agent), or
- full title (exact match only; no partial title matching)

Resolution happens server-side using the daemon’s registry/index.

Clients do not fetch full lists just to resolve.

### D) “Send prompt” becomes an RPC with acks

`sendAgentMessage` must block until the server has accepted the message and either started the run or produced a definitive error response.

After that, wait logic can be simple and deterministic.

## Protocol / API Changes (Server ↔ Client)

### 1) Agent list RPCs

Add explicit RPC(s):

- `fetch_agents_request { requestId, filter?: { labels?: Record<string,string> } }`
- `fetch_agents_response { requestId, agents: AgentSnapshotPayload[] }`

Notes:
- Label filtering must remain.
- This replaces `request_agent_list` as a “void” message and `agent_list` as an uncorrelated response (all list fetches must be requestId-correlated).

### 2) Single-agent fetch RPC

Add:

- `fetch_agent_request { requestId, agentId: string }`
- `fetch_agent_response { requestId, agent?: AgentSnapshotPayload, error?: string }`

Notes:
- `agentId` accepts full ID, unique prefix, or full title; server resolves.
- This is the canonical tool for `wait`/`inspect`/etc to avoid fetching the full list.

### 3) ID resolution on server

Resolution is applied anywhere the server accepts `agentId`:

- `send_agent_message_request`
- `wait_for_finish_request` (if added)
- `stop_agent_request`, `archive_agent_request`, etc.

If ambiguous:
- return a structured error (no silent best-effort selection).

### 4) Subscriptions

Keep label filtering.

Add support for “single agent” subscription (can be implemented as server-side filter wrapper):

- `subscribe_agent_updates { subscriptionId, filter?: { labels?, agentId? } }`

Notes:
- The daemon should only deliver matching updates to that subscription.

### 5) Send message as RPC (core change)

Replace the current fire-and-forget `send_agent_message` with:

- `send_agent_message_request { requestId, agentId, text, messageId?, images? }`
- `send_agent_message_response { requestId, agentId, accepted: boolean, error?: string }`

Required guarantee:
- When `send_agent_message_response.accepted === true`:
  - the provider has ACKed the message (per provider integration), and
  - the server has already invoked the code path that flips the agent lifecycle to `running`.

### 6) Wait-for-finish RPC (required)

Add:

- `wait_for_finish_request { requestId, agentId, timeoutMs? }`
- `wait_for_finish_response { requestId, final: AgentSnapshotPayload, status: "idle"|"error"|"permission"|"timeout" }`

Semantics (unchanged from today):
- Return immediately if the agent is already `idle` or `error`, or has pending permissions.
- Otherwise block until the agent becomes `idle`/`error`, or requests permissions, or the timeout is reached.

Notes:
- No “after boundary” support in this refactor.
- Client-side waiting is allowed (callers can build it), but the CLI should rely on the server wait RPC.

## Client Library Changes (`DaemonClient`)

### 1) Remove “agent cache as a feature”

Deprecate/remove:

- `listAgents()` as the “canonical list”
- any behavior that assumes the client owns the authoritative agent list

If the client keeps a tiny cache, it should be explicitly named “cache” and never required for correctness.

### 2) Remove messageQueue as a public feature

We should not rely on:

- scanning historical message queues to infer run transitions
- exposing `getMessageQueue()` / `clearMessageQueue()` for app/CLI logic

RPC correctness should come from requestId correlation, not queue replay.

### 3) Introduce clear RPC methods

Add explicit methods (names reflect behavior):

- `fetchAgents(filter?): Promise<AgentSnapshotPayload[]>`
- `fetchAgent(agentId: string): Promise<AgentSnapshotPayload | null>`
- `sendAgentMessage(agentId: string, ...): Promise<{ accepted: boolean; agentId: string }>`
- `waitForFinish(agentId: string, timeoutMs?: number): Promise<{ status: "idle"|"error"|"permission"|"timeout"; final?: AgentSnapshotPayload }>`
- `subscribeAgentUpdates({ labels?, agentId? }): SubscriptionId`

### 4) `waitForFinish` rewrite

Replace `sawStart`/queue-scanning logic with a requestId-correlated server RPC.

## CLI Changes

### 1) No full-list fetch for prefix resolution

CLI should not do:
- `requestAgentList()` + `sleep` + `resolveAgentId(prefix)`

Instead:
- pass the user-provided `agentId` (full or prefix) to the server and let it resolve.

### 2) `paseo wait` behavior becomes deterministic

`paseo wait <agentId>`:

- returns immediately if agent is already idle/error/permission (server-determined)
- otherwise blocks until the server reports idle/error/permission or timeout

## Acceptance Criteria

- `await sendAgentMessage(...)` guarantees that, on success, the provider ACKed the message and the agent lifecycle has flipped to `running` on the server.
- `paseo wait` does not hang when the agent is already idle.
- No CLI command fetches the full agent list just to resolve a prefix.
- Label filtering remains supported for list fetches and subscriptions.
- Subscriptions can be scoped to a single agent (server-side filter).
- `DaemonClient` no longer exposes messageQueue APIs for correctness.

## Verification / Testing Criteria

This refactor is only “done” if we can test each guarantee deterministically across the in-repo clients: CLI, app, and tests.

### 1) Server: agentId resolution (unit/integration)

Add server-side tests that prove:

- Full ID resolves.
- Unique prefix resolves.
- Exact full title resolves.
- Ambiguous prefix errors.
- Ambiguous title errors (two agents same title) OR define “titles must be unique” and enforce that.
- Unknown identifier errors.

### 2) Server: `fetch_agents` (integration)

Add tests that prove:

- `fetch_agents(filter.labels)` returns only matching agents.
- Response is requestId-correlated (no reliance on passive `agent_list` events).

### 3) Server: `fetch_agent` (integration)

Add tests that prove:

- `fetch_agent` returns exactly one agent for full ID / unique prefix / exact title.
- `fetch_agent` errors for ambiguous prefix/title.
- `fetch_agent` returns not found for unknown.

### 4) Server: `send_agent_message` RPC semantics (integration)

Add tests that prove:

- When `send_agent_message_response.accepted === true`, a subsequent `fetch_agent` shows the agent lifecycle is `running` (no eventual consistency hand-waving).
- When the server cannot start the run, the response is `accepted === false` with a structured error (and no false “running” state).

### 5) Server: `wait_for_finish` (integration)

Add tests that prove:
- If agent is already `idle`, `wait_for_finish` returns immediately with `status: "idle"`.
- If agent is already `error`, returns immediately with `status: "error"`.
- If agent is awaiting permission, returns immediately with `status: "permission"`.
- If agent is running, it blocks and returns `idle/error/permission` once that occurs.
- Timeout returns `status: "timeout"` deterministically.

### 6) CLI: “no agent list just to resolve” (static + behavior)

Update CLI tests (existing `packages/cli/tests`) to use:

- `fetch_agent` + server-side resolution for `wait/inspect/send/stop/...`
- `fetch_agents` for `ls`

Additionally add a lightweight static guard test (or CI check) that fails if CLI reintroduces:

- `requestAgentList()` usage, or
- `listAgents()` usage for ID resolution

### 7) App (Expo): deterministic hydration flow (integration)

Update app to:

- call `fetchAgents({ labels: { ui: "true" } })` for initial hydration
- subscribe to deltas via `subscribeAgentUpdates({ labels: { ui: "true" } })`

Add tests (or E2E assertions) that prove:

- the app no longer depends on `agent_list` arriving opportunistically
- “agent list ready” flips only after `fetchAgents` completes successfully or fails deterministically

### 8) Remove messageQueue reliance (repo-wide)

Update server E2E tests that currently depend on:

- `getMessageQueue()` / `clearMessageQueue()`

to instead:

- use requestId-correlated RPC responses, and/or
- explicit event listeners that collect events per test scope (test-owned buffers, not client-owned global queues).

## Implementation Notes / Risks

- Removing `messageQueue` impacts many daemon E2E tests that currently inspect the queue to assert streaming/tool-call sequences.
  - Replace those tests with event listeners + explicit requestIds, or add test-only hooks.
- Server-side “agentId prefix resolution” must have clear ambiguity rules and error payloads.
- If we keep “agentId” as the key name, document that the server accepts prefixes and resolves to canonical IDs.
