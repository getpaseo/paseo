# ACP Agent Manager

Phase 1 implementation of Agent Client Protocol (ACP) integration for managing Claude Code agents.

## Overview

This module provides core infrastructure for spawning, managing, and communicating with Claude Code agents via the ACP SDK. It does NOT integrate with the rest of the application yet - that's for Phase 2.

## Files

- `types.ts` - TypeScript types and interfaces
- `agent-manager.ts` - Core AgentManager class
- `test-agent.ts` - Full test script with detailed logging
- `test-simple.ts` - Quick test with minimal output
- `test-concurrent.ts` - Concurrent agents and cancellation test

## Usage

### Basic Example

```typescript
import { AgentManager } from "./acp/agent-manager.js";

const manager = new AgentManager();

// Create an agent
const agentId = await manager.createAgent({
  cwd: process.cwd(),
  plan: "List files in current directory", // Optional initial prompt
});

// Subscribe to updates
manager.subscribeToUpdates(agentId, (update) => {
  console.log("Update:", update.notification);
});

// Send a prompt
await manager.sendPrompt(agentId, "Do something");

// Check status
const status = manager.getAgentStatus(agentId); // "ready" | "processing" | etc

// Cancel current task
await manager.cancelAgent(agentId);

// Kill the agent
await manager.killAgent(agentId);
```

### Multiple Agents

```typescript
const agent1 = await manager.createAgent({ cwd: "/path/1" });
const agent2 = await manager.createAgent({ cwd: "/path/2" });

// Send different prompts
await manager.sendPrompt(agent1, "Task 1");
await manager.sendPrompt(agent2, "Task 2");

// List all agents
const agents = manager.listAgents();
agents.forEach((agent) => {
  console.log(`${agent.id}: ${agent.status}`);
});
```

## Agent Lifecycle

1. **initializing** - Agent process starting, ACP connection being established
2. **ready** - Agent is ready to receive prompts
3. **processing** - Agent is working on a task
4. **completed** - Task finished successfully
5. **failed** - Agent encountered an error
6. **killed** - Agent was terminated

## Session Updates

The agent sends various types of updates via the `subscribeToUpdates` callback:

- `sessionUpdate: "agent_message_chunk"` - Streaming response text
- `sessionUpdate: "tool_call"` - Agent is calling a tool (terminal, file read, etc)
- `sessionUpdate: "tool_call_update"` - Tool call status update
- `sessionUpdate: "available_commands_update"` - List of available slash commands
- And more...

See the ACP SDK documentation for full list of notification types.

## Testing

Run the test scripts to verify everything works:

```bash
# Full test with detailed logging
npx tsx src/server/acp/test-agent.ts

# Quick test with minimal output
npx tsx src/server/acp/test-simple.ts

# Test concurrent agents and cancellation
npx tsx src/server/acp/test-concurrent.ts
```

## Implementation Details

### Process Management

- Spawns `npx @zed-industries/claude-code-acp` as subprocess
- Uses stdio for ACP communication (stdin/stdout)
- Stderr captured for debugging
- Automatic cleanup on kill (SIGTERM, then SIGKILL after 5s)

### ACP Connection

- Uses `ClientSideConnection` from `@agentclientprotocol/sdk`
- Implements required callbacks: `sessionUpdate`, `requestPermission`, `readTextFile`, `writeTextFile`
- Auto-approves permissions for now (Phase 1 only)

### Update Streaming

- All session updates forwarded to subscribers via callback
- Multiple subscribers supported per agent
- Updates include timestamp and agent ID
- Subscribers handle their own error recovery

## Known Limitations (Phase 1)

- No integration with Session or WebSocket
- No MCP tools exposed yet
- Auto-approves all permissions (no user confirmation)
- File read/write callbacks return empty/mock data
- No persistence of agent state
- No authentication

## Next Steps (Phase 2)

- Integrate with Session class
- Add MCP tools for agent control
- Expose via WebSocket to UI
- Add proper permission handling
- Connect file read/write to actual filesystem
- Add conversation persistence
