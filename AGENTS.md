# Agent Lifecycle

This project uses client-driven lazy initialization for Claude Code agents. Sessions start without spinning up agent runtimes; the client opts in when needed.

## Connection Bootstrapping
- The session emits `session_state` after connection with an array of agents. Each entry matches the server `AgentInfo` structure (`id`, `status`, `createdAt`, `type`, `sessionId`, `error`, `currentModeId`, `availableModes`, `title`, `cwd`).
- No history or runtime is loaded at this point. Every agent starts in `uninitialized` and only streams live status updates once subscribed.

## Opting In To An Agent
1. When the UI needs an agent, send an inbound session message:

   ```json
   {
     "type": "initialize_agent_request",
     "agentId": "<agent-id>",
     "requestId": "<optional-correlation-id>"
   }
   ```

2. The session subscribes to the agent, calls `AgentManager.initializeAgentAndGetHistory`, and lazily starts the runtime if required.
3. The server responds with:

   ```json
   {
     "type": "agent_initialized",
     "payload": {
       "agentId": "<agent-id>",
       "info": { /* same shape as session_state agents */ },
       "updates": [
         {
           "agentId": "<agent-id>",
           "timestamp": "2024-01-01T00:00:00.000Z",
           "notification": { /* AgentNotification */ }
         }
       ],
       "requestId": "<optional-correlation-id>"
     }
   }
   ```

4. After the response, all ongoing traffic uses the existing channels:
   - `agent_status` continues to broadcast status changes.
   - `agent_update` streams real-time session notifications, permission prompts, etc.

## Notes
- `initialize_agent_request` is idempotent. The manager short-circuits if the agent is already ready and returns the cached history.
- Session state no longer replays history when clients reconnect; clients must explicitly reinitialize agents they care about.
- `requestId` lets the caller correlate UI state but remains optional throughout the flow.
