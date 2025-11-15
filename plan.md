Refactor plan: full migration from ACP to the SDK AgentManager stack. This is a hard refactor—no shims, no temporary adapters. It’s acceptable (and expected) that TypeScript won’t compile in intermediate steps
as long as we keep pushing forward toward the final architecture, and have strong typing in place.

These tasks need to be done sequentially by different agents:

- [x] Inventory every ACP dependency (server session/websocket/messages/MCP/title generator/frontend reducers) and document the new AgentManager equivalents + message contracts (see docs/acp-dependency-inventory.md)
- [x] Redesign server message schemas around AgentSnapshot/AgentStreamEvent and add helper types/serializers for the new provider/timeline structures
- [x] Swap server entry (index.ts) to instantiate AgentRegistry + SDK AgentManager (Claude/Codex clients), restore persisted agents, and broadcast agent_state events
- [x] Rewrite WebSocket server + Session controller to use AgentManager APIs (create/resume/run/permissions/ mode) and stream events directly, removing ACP calls
- [x] Review to ensure we haven't lost any functionality or added any regressions, update this list with more tasks as needed (frontend still expects ACP `agent_*` packets, backend title generator + worktree scripts also need updating)
- [x] Update backend services (title generator, MCP bridge, terminal integrations) to consume AgentManager snapshots/events instead of ACP AgentUpdates (title generator now reads AgentManager timelines via the new curator; MCP bridge + terminal integrations already consume AgentManager events)
- [x] Refactor frontend session context + reducers (SessionContext, reduceStreamUpdate, activity components) to handle the new agent_state/agent_stream schemas
- [x] Check work so far, and update this list with more tasks as needed
- [x] Hydrate agent stream history when sessions connect so existing AgentManager timelines appear without manual initialize_agent_request (send timeline snapshots from Session and reuse them in SessionContext)
- [x] Render the remaining AgentTimelineItem variants (command/file_change/web_search/todo/error) in the frontend stream reducer + UI so the new schema is fully visible
- [x] Implement MCP tool surface (agent-mcp) on top of AgentManager snapshots/permissions, drop ACP tooling
- [x] Add persistence hooks (AgentRegistry usage throughout, ensure titles/modes saved) and cover new flows with integration tests
- [x] Delete test: ACP should be gone from the codebase
- [x] Run lint/typecheck/unit/integration suites; stage manual verification (multi-agent sessions, permissions, plan mode, resume)
- [x] Peer review of backend changes; address feedback, then review frontend changes; final regression pass before merging
- [x] Final review of the codebase: check for duplicated code, untyped code, unused imports, etc.

# Context

Session now subscribes directly to `AgentManager` events and forwards `agent_state`, `agent_stream`, and permission messages; the websocket layer is back to a thin transport. Next agent should verify downstream consumers (frontend + MCP services) can ingest the new stream schema.
