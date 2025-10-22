# Phase 2: ACP Integration - Session and MCP Tools

This document describes the Phase 2 implementation that integrates AgentManager with the Session and MCP tools infrastructure.

## Overview

Phase 2 enables the orchestrator LLM to create and control Claude Code agents via function calls. Agents run as separate processes and can execute coding tasks autonomously, with their updates streamed back to the UI via WebSocket.

## Architecture

### Components

1. **Agent MCP Server** (`mcp-server.ts`)
   - Exposes 6 tools to the LLM for agent management
   - Each Session gets its own AgentManager instance
   - Uses in-memory transport to connect to Session's MCP client

2. **WebSocket Messages** (`messages.ts`)
   - Three new message types: `agent_created`, `agent_update`, `agent_status`
   - Agent updates flow directly to WebSocket (NOT through LLM)
   - Enables real-time UI feedback for agent work

3. **Session Integration** (`session.ts`)
   - Each session owns an AgentManager
   - Initializes agent MCP server on startup
   - Subscribes to agent updates and forwards to WebSocket
   - Cleans up all agents on session end

4. **getAllTools** (`llm-openai.ts`)
   - Updated to accept agent tools parameter
   - Merges terminal, agent, Playwright, and manual tools
   - Per-session tool sets enable isolation

## Tools Available to LLM

### `create_coding_agent`

Creates a new Claude Code agent.

**Input:**
- `plan` (optional): Initial task for the agent

**Output:**
- `agentId`: Unique identifier for the agent
- `status`: Current agent status

**Example:**
```typescript
{
  plan: "Refactor the authentication module to use JWT tokens"
}
```

### `send_agent_prompt`

Sends a task or instruction to an agent.

**Input:**
- `agentId`: Agent to send prompt to
- `prompt`: Task or instruction

**Output:**
- `success`: Whether prompt was sent

**Example:**
```typescript
{
  agentId: "abc-123",
  prompt: "Add unit tests for the new functions"
}
```

### `get_agent_status`

Gets current status and info about an agent.

**Input:**
- `agentId`: Agent to query

**Output:**
- `status`: Current status
- `info`: Detailed agent information

### `list_agents`

Lists all active agents in this session.

**Input:** None

**Output:**
- `agents`: Array of agent info objects

### `cancel_agent`

Cancels an agent's current task (keeps agent alive).

**Input:**
- `agentId`: Agent to cancel

**Output:**
- `success`: Whether cancellation succeeded

### `kill_agent`

Terminates an agent completely.

**Input:**
- `agentId`: Agent to kill

**Output:**
- `success`: Whether kill succeeded

## Data Flow

### Agent Creation Flow

1. LLM calls `create_coding_agent` tool
2. Agent MCP server creates agent via AgentManager
3. AgentManager spawns `npx @zed-industries/claude-code-acp` process
4. Session intercepts tool result, sees `agentId`
5. Session subscribes to agent updates
6. Session emits `agent_created` message to WebSocket

### Agent Update Flow

1. Agent process sends ACP session updates
2. AgentManager receives updates via ACP callback
3. AgentManager notifies subscribers (including Session)
4. Session forwards update to WebSocket as `agent_update` message
5. UI receives update and can display progress

**Important:** Agent updates bypass the LLM and go directly to the UI. This prevents the LLM from being overwhelmed with agent activity while still providing real-time feedback to the user.

### Agent Cleanup Flow

1. Session cleanup is triggered (client disconnect, timeout, etc.)
2. Session iterates through all agents
3. Calls `AgentManager.killAgent()` for each
4. Unsubscribes from all agent updates
5. Closes agent MCP client

## Session Lifecycle

```typescript
// On Session creation
constructor() {
  this.agentManager = new AgentManager()
  this.initializeAgentMcp()  // Async initialization
}

// During LLM processing
async processWithLLM() {
  // Wait for agent MCP to initialize
  while (!this.agentTools && timeout) { await sleep(100) }

  // Get all tools (includes agent tools)
  const allTools = await getAllTools(this.terminalTools, this.agentTools)

  // Stream with tools available
  await streamText({ tools: allTools, ... })
}

// On create_coding_agent tool result
onChunk({ type: "tool-result", toolName: "create_coding_agent" }) {
  const agentId = result.structuredContent.agentId
  this.subscribeToAgent(agentId)  // Start receiving updates
  this.emit({ type: "agent_created", ... })
}

// On Session cleanup
async cleanup() {
  // Kill all agents
  for (const agent of this.agentManager.listAgents()) {
    await this.agentManager.killAgent(agent.id)
  }

  // Unsubscribe from all updates
  for (const unsubscribe of this.agentUpdateUnsubscribers.values()) {
    unsubscribe()
  }

  // Close MCP clients
  await this.agentMcpClient.close()
}
```

## Testing

### Integration Test

Run the integration test to verify the complete flow:

```bash
npx tsx src/server/acp/test-integration.ts
```

The test:
1. Creates AgentManager
2. Sets up Agent MCP server
3. Connects MCP client
4. Verifies all 6 tools are present
5. Creates an agent
6. Subscribes to agent updates
7. Tests agent operations (status, prompt, cancel)
8. Kills agent and verifies cleanup

### Manual Testing

Once Phase 3 (UI) is complete, you can test via the voice interface:

1. Start the server: `npm run dev`
2. Connect via browser
3. Say: "Create a coding agent to refactor the auth module"
4. LLM will call `create_coding_agent` tool
5. Watch agent updates in the UI as it works
6. Say: "Check the agent status"
7. LLM will call `get_agent_status` tool

## Key Design Decisions

### Per-Session AgentManager

Each Session gets its own AgentManager instance. This ensures:
- Agent isolation between conversations
- Clean cleanup when session ends
- No shared state between users

### Direct Update Streaming

Agent updates go directly to WebSocket, not through LLM:
- Prevents LLM prompt pollution
- Enables real-time UI feedback
- Reduces token usage
- Allows parallel agent and LLM work

### Tool Result Interception

Session intercepts `create_coding_agent` tool results to:
- Automatically subscribe to new agents
- Emit `agent_created` message
- No manual tracking needed by LLM

### Graceful Initialization

Agent MCP initializes asynchronously:
- Session creation doesn't block on initialization
- LLM waits for tools before first call
- 5 second timeout with clear error
- Allows fast session creation

## Files Modified

### New Files
- `src/server/acp/mcp-server.ts` - Agent MCP server with 6 tools
- `src/server/acp/test-integration.ts` - Integration test script
- `src/server/acp/PHASE2-INTEGRATION.md` - This documentation

### Modified Files
- `src/server/messages.ts` - Added 3 agent message types
- `src/server/session.ts` - Integrated AgentManager
- `src/server/agent/llm-openai.ts` - Updated getAllTools signature

## Next Steps: Phase 3

Phase 3 will add UI components to:
- Display agent creation notifications
- Stream agent updates in real-time
- Show agent status and progress
- Allow manual agent control (cancel, kill)
- Display agent work artifacts

## Troubleshooting

### "Agent MCP failed to initialize"

Check:
- `@zed-industries/claude-code-acp` is installed
- Node version is compatible
- No firewall blocking spawned processes

### "Agent not found"

Likely causes:
- Agent was killed or crashed
- Using wrong agentId
- Session was cleaned up

### Agent updates not received

Check:
- Subscription was created after agent creation
- WebSocket connection is active
- Agent process is still running
