Refactor plan: full migration from ACP to the SDK AgentManager stack. This is a hard refactor—no shims, no temporary adapters. It’s acceptable (and expected) that TypeScript won’t compile in intermediate steps
as long as we keep pushing forward toward the final architecture, and have strong typing in place.

Commit after each task with a descriptive commit message.

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

# User testing and review

- [x] The create new agent modal stay in "Creating agent..." state forever, but the agent is created, if I close it I can see the agent in the list, hmm but wait when I click on the agent it says "Loading agent..." forever, I can see clean logs in the server, no errors:

  Fixed by ensuring the server always emits an `agent_stream_snapshot` (even when empty) so the frontend clears the initializing state after a successful agent creation/initialization.

````log
[WS] create_agent_request details: {
cwd: '~/dev/voice-dev',
initialMode: 'full-access',
worktreeName: undefined,
requestId: 'msg_1763196834129_jtfh2egsk'
}
[Session client-4] Creating agent in ~/dev/voice-dev (codex)
[Session client-4] Created agent 29d1ee14-7687-44ce-8cd2-7c58b74288fa (codex)
[WS] Received message type: session {
type: 'session',
message: {
type: 'initialize_agent_request',
agentId: '29d1ee14-7687-44ce-8cd2-7c58b74288fa'
}
}
[Session client-4] Initializing agent 29d1ee14-7687-44ce-8cd2-7c58b74288fa on demand
[Session client-4] Agent 29d1ee14-7687-44ce-8cd2-7c58b74288fa initialized with 0 timeline item(s)
``

- [x] Super important: sending a prompt to an agent doesnt interrupt it, it must interrupt it and start a new turn, on top of their partial already streamed response.
  Fixed by interrupting the agent's active run (Session.interruptAgentIfRunning) before starting a new stream so each prompt spins up a fresh turn immediately after the partial response ends.
- [x] We should not have separate edit, command and tool call events. Everything should be a tool call and be treated the same. Web fetch and editing a file should be shown the same for example in the agent stream view. Right now the commands and file edit are shown differently. Tool calls should show a loading pill when executing and then a completed pill when it's done. That pill when click we show the tool call bottom sheet. This was already working before.
  - `AgentTimelineItem` now only uses `assistant_message`, `reasoning`, `tool_call`, `todo`, and `error` entries—Codex/Claude providers emit unified tool call payloads (callId, kind, displayName, input/output/error) for commands, MCP tools, file edits, web search, and permission prompts.
  - The frontend stream reducer consumes the new tool call schema directly, so pills/bottom sheet share the same loading/completed lifecycle with raw inputs preserved for diff rendering again.
  - `activity-curator`, tests, and docs updated to describe the shared tool call contract. Follow-up: the dedicated permission-hiding task below can now simply filter `tool_call` entries with `server === "permission"` or `kind === "permission"`.

- [x] I also noticed that with tool calls, we're not showing the input? we're dropping it somewhere, i notcied this with Claude tool calls, make sure you add a test for this, ask it to write a file or run a specific non-destructive command and assert that tool call are being emitted with the correct data. (Stream reducer now preserves the initial raw tool input payload, and `test-idempotent-stream.ts` includes `testToolCallInputPreservation` to guard against regressions.)
- [x] For the agent stream assistant message. I don't know how it happens but we lose spaces, like all the words are merged together. Maybe we are trimming chunks? (Fixed by preserving whitespace in `packages/app/src/types/stream.ts`; `test-idempotent-stream.ts` now includes `testAssistantWhitespacePreservation`—needs `ts-node/tsx` or similar runner since `node test-idempotent-stream.ts` currently fails on TS imports.)
- [x] Agents are being wiped out on restart: [AgentRegistry] Failed to load agents: SyntaxError: Unexpected non-whitespace character after JSON at position 368 (line 16 column 2)
  - AgentRegistry now recovers when `agents.json` has trailing garbage (e.g. write crashes) by trimming to the last valid array, rewriting a sanitized copy, and continuing to load cached agents. Covered by `recovers from trailing garbage in agents.json` in `agent-registry.test.ts`.
- [x] We should not be showing permission granted/denied messages in the agent stream view. Permissions are only relevant when they're awaiting for a response, and we already had thism make sure its wirded up. (Filtered permission tool_call entries with `server === "permission" || kind === "permission"` in `packages/app/src/types/stream.ts`; `test-idempotent-stream.ts` now has `testPermissionToolCallFiltering`.)
- [x] In the file browser, we should show an icon for the file type on the right, for a quick visual clue of the file type. Support directory, image, text file or other. (Implemented directory/image/text/other detection in `file-explorer.tsx` with lucide icons.)
- [x] In the file browser we should remember the scroll when we come back from the file preview. It's frustrating to have to scroll back to where you were.
  - Scroll position is now captured per directory view and restored when leaving a preview; changing directories still resets the offset to the top so navigation semantics stay predictable.
- [x] Add an agent kind indicator in the agent list, so we can quickly identify the agent kind (Claude, Codex, etc.). On the left of the status pill. (AgentSidebar now pulls the provider label from `getAgentProviderDefinition` and renders a muted badge between the cwd and status pill so Claude/Codex are visible at a glance.)

# User testing round 2

- [x] File browser icons are not showing up, they should be on the left side of the file name. (Icons now render before the filename with a fixed-width container so alignment stays consistent.)
- [x] Creating an agent doesnt redirect to the agent screen, it stays on the create agent modal. Hmm wait, its a bit of a hit and miss? Ah wait, i know, it only works for Codex for some reason. Claude hangs but the agent is in the list.
  - Fixed by subscribing once to `status` messages inside `create-agent-modal.tsx` and matching against a persistent pending request ref so we can't miss the `agent_created` ack if it arrives before the effect registers. Both Codex and Claude creation now close the modal and redirect reliably.
- [x] User messages are not showing up across deamon restarts when loading agents, at least for Codex. I see assistant messages though, review Claude too just in case, add a regression test for this.
  - AgentManager now records `user_message` timeline entries whenever text/audio prompts are sent (including message IDs) and emits them through `agent_stream_snapshot` so codex/claude history hydrates correctly after reconnects. The frontend reducer dedupes optimistic entries using the shared messageId, and `test-idempotent-stream.ts` includes `testUserMessageHydration` to guard against regressions.
- [x] Improve the file browser loading states, at the moment when we load a big directory, it just hangs on click, we should navigate immediately and show a loading state. (File explorer now switches paths optimistically and shows dedicated directory-loading banners/spinners driven by the pending request so clicks provide instant feedback even before entries stream back.)
- [x] Make the browser file list be a virtualized list to support large dirs. (File explorer now renders entries through a virtualized FlatList so scroll state + loading banners remain intact even for thousands of files.)
- [x] This is still happening, especially when the dev server restarts due to changes. I winder if we're not writing that file atomically or something?
  [AgentRegistry] Failed to load agents: SyntaxError: Unexpected non-whitespace character after JSON at position 1848 (line 69 column 1)
      at JSON.parse (<anonymous>)
      at AgentRegistry.parseRecords (
  Might be related I noticed we wrote this file:
  ls -lah packages/server/packages/server/agents.json
  -rw-r--r--@ 1 moboudra  staff   1.8K 15 Nov 10:53 packages/server/packages/server/agents.json

  It's in the wrong place, make sure all file writes are atomic and single source of truth. File being written in different places is a big red flag.
  - AgentRegistry now resolves the server workspace root (so writes always land in `packages/server/agents.json` regardless of cwd) and flushes via temp-file+rename to avoid partial writes; sanitized rewrites reuse the same atomic helper.

- [x] something is clearly wrong with the storage:

  [Session client-1] Failed to record agent config for f74ce920-d398-41a3-a9ca-cf5151f1afad: Error: ENOENT: no such file or directory, rename '/Users/moboudra/dev/voice-dev/packages/server/.agents.json.tmp-67975-1763201899064' -> '/Users/moboudra/dev/voice-dev/packages/server/agents.json'
      at async Object.rename (node:internal/fs/promises:786:10)
      at async writeFileAtomically (/Users/moboudra/dev/voice-dev/packages/server/src/server/agent/agent-registry.ts:276:3)
      at async AgentRegistry.flush (/Users/moboudra/dev/voice-dev/packages/server/src/server/agent/agent-registry.ts:180:5)
      at async AgentRegistry.recordConfig (/Users/moboudra/dev/voice-dev/packages/server/src/server/agent/agent-registry.ts:130:5)
      at async Session.handleCreateAgentRequest (/Users/moboudra/dev/voice-dev/packages/server/src/server/session.ts:897:9)
      at async Session.handleMessage (/Users/moboudra/dev/voice-dev/packages/server/src/server/session.ts:550:11)
      at async VoiceAssistantWebSocketServer.handleMessage (/Users/moboudra/dev/voice-dev/packages/server/src/server/websocket-server.ts:184:15) {
    errno: -2,
    code: 'ENOENT',
    syscall: 'rename',
    path: '/Users/moboudra/dev/voice-dev/packages/server/.agents.json.tmp-67975-1763201899064',
    dest: '/Users/moboudra/dev/voice-dev/packages/server/agents.json'
  }

  Cause was colliding temp filenames when multiple flushes landed in the same millisecond; `writeFileAtomically` now adds a `randomUUID` suffix so each flush writes to a unique tmp file before renaming.

- [x] I am not seeing my user messages in the agent stream view,  on deamon restart. This was on Claude. Make sure you test this. Create agent, then hydrate it only from the persitance assert that you see the same events you received when creating the agent.
  - Claude history hydration now recognizes `user` entries inside the provider JSONL logs and converts them into `user_message` timeline items (via `extractUserMessageText`), so persisted agents replay the full turn order after a daemon restart. Added `claude-agent.history.test.ts` to lock in the parser behavior.

# New feature, resuming agents that were created outside of the app

The new architecture supports this, which is great, lets take advantage of it and implement this.

- [x] In the new agent screen, we should add a toggle at the top, "new agent" or "resume agent", and when we toggle to "resume agent", we should show a list of agents that were created outside of the app, be able to filter by agent provider, you can leverage the ~/.claude and ~/.codex directories to list the agents available. Make sure you use a flat list as the agent list can be long. Allow searching by title. If not tile is provided by the persisted state, use the first message in the chat. For each item show the title, directory, time since last activity (sort by this). When we click on an item, we should hydrate this agent and put it into our own agent list. Maybe just load the last 20 or something for now sorted by date. Implement the list functionality in the providers to abstract this logic per provider.
  - Server now exposes `list_persisted_agents_request` + `resume_agent_request`; provider clients look at `~/.claude/projects` + `~/.codex/sessions` and hydrate the latest 20 entries (title falls back to the first user message). The modal has a New/Resume toggle, provider chips, search, and a refreshed FlatList; tapping a card calls the new resume flow and shows a spinner until the `agent_resumed` status arrives. Follow-up: pagination/empty states beyond the first 20 items and persisting the fetched list client-side might be worth exploring if we need quicker refreshes.


- [x] The resume flow works well, but I'd like that when I use the Codex/Claude session in my laptop, which changes the storage in the home dir, we hydrate those somehow? dot know whats the best way, maybe we poll them and if tere are changes we re-emit new events? This way jumping between laptop and mobile is seamless. Maybe it's client driven, so when we navigate to an agent screen we check for new persised messages we haven't seen yet? If this is challenging but doable lets do it. If it's super hard, lets just add a "Refresh button" in the agent three dot menu, that esentially reloads the agent from scratch so we dont ahve to keep track of the messages we have seen and not seen. But the ideal solution is that its automatic for best UX.
  - Added a manual "Refresh from disk" action in the agent three-dot menu; it rehydrates the agent via a new `refresh_agent_request`, swapping in a freshly resumed SDK session and replaying its full persisted timeline. This is a client-triggered refresh (automatic polling still TBD so future agents can revisit if we want background sync).

# Context

Session now subscribes directly to `AgentManager` events and forwards `agent_state`, `agent_stream`, and permission messages; the websocket layer is back to a thin transport. Next agent should verify downstream consumers (frontend + MCP services) can ingest the new stream schema.

```

```
````
