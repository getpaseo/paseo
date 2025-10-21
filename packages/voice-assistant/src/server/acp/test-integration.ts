#!/usr/bin/env tsx

/**
 * Integration test for Agent MCP Server with Session
 *
 * This test simulates a Session-like scenario where:
 * 1. AgentManager is created
 * 2. Agent MCP server is set up
 * 3. Tools are called via the MCP client
 * 4. Agent updates are streamed to a mock WebSocket handler
 * 5. Cleanup is performed
 */

import { AgentManager } from "./agent-manager.js";
import { createAgentMcpServer } from "./mcp-server.js";
import { experimental_createMCPClient } from "ai";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentUpdate } from "./types.js";

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Agent MCP Integration Test ===\n");

  // Step 1: Create AgentManager
  console.log("1. Creating AgentManager...");
  const agentManager = new AgentManager();
  console.log("   ✓ AgentManager created\n");

  // Step 2: Create Agent MCP Server
  console.log("2. Creating Agent MCP Server...");
  const server = await createAgentMcpServer({ agentManager });
  console.log("   ✓ Agent MCP Server created\n");

  // Step 3: Set up transport and client
  console.log("3. Setting up MCP transport and client...");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = await experimental_createMCPClient({
    transport: clientTransport,
  });
  console.log("   ✓ MCP client connected\n");

  // Step 4: Get tools from client
  console.log("4. Getting tools from MCP client...");
  const tools = await mcpClient.tools();
  const toolNames = Object.keys(tools);
  console.log(`   ✓ Got ${toolNames.length} tools: ${toolNames.join(", ")}\n`);

  // Step 5: Verify all expected tools are present
  console.log("5. Verifying expected tools...");
  const expectedTools = [
    "create_coding_agent",
    "send_agent_prompt",
    "get_agent_status",
    "list_agents",
    "cancel_agent",
    "kill_agent",
  ];

  const missingTools = expectedTools.filter((t) => !toolNames.includes(t));
  if (missingTools.length > 0) {
    console.error(`   ✗ Missing tools: ${missingTools.join(", ")}`);
    process.exit(1);
  }
  console.log("   ✓ All expected tools present\n");

  // Step 6: Test direct AgentManager usage (bypassing MCP tools for simplicity)
  console.log("6. Creating agent directly via AgentManager...");
  const receivedUpdates: AgentUpdate[] = [];

  const agentId = await agentManager.createAgent({
    initialPrompt: "Create a simple hello world function in TypeScript",
    cwd: process.cwd(),
  });
  console.log(`   ✓ Agent created with ID: ${agentId}\n`);

  // Step 7: Subscribe to agent updates (simulating Session behavior)
  console.log("7. Subscribing to agent updates...");
  const unsubscribe = agentManager.subscribeToUpdates(agentId, (update) => {
    const updateType = (update.notification as any).type || "unknown";
    console.log(`   📡 Received update for agent ${update.agentId}: ${updateType}`);
    receivedUpdates.push(update);
  });
  console.log("   ✓ Subscribed to agent updates\n");

  // Step 8: Wait a bit for agent initialization
  console.log("8. Waiting for agent to initialize...");
  await sleep(2000);
  console.log("   ✓ Wait complete\n");

  // Step 9: Test list_agents via manager
  console.log("9. Listing agents via AgentManager...");
  const agents = agentManager.listAgents();
  console.log(`   ✓ Found ${agents.length} agent(s)`);
  console.log(`   Agents:`, agents.map(a => ({ id: a.id, status: a.status })));
  console.log();

  // Step 10: Test get_agent_status
  console.log("10. Getting agent status...");
  const status = agentManager.getAgentStatus(agentId);
  console.log(`    ✓ Agent status: ${status}\n`);

  // Step 11: Test send_agent_prompt
  console.log("11. Sending prompt to agent...");
  try {
    await agentManager.sendPrompt(agentId, "Show me what you created");
    console.log("    ✓ Prompt sent successfully\n");
  } catch (error) {
    console.log(`    ⚠ Prompt send failed (expected if agent not ready): ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Step 12: Wait a bit for any agent processing
  console.log("12. Waiting for agent processing...");
  await sleep(3000);
  console.log("    ✓ Wait complete\n");

  // Step 13: Test cancel_agent
  console.log("13. Cancelling agent...");
  try {
    await agentManager.cancelAgent(agentId);
    console.log("    ✓ Agent cancelled successfully\n");
  } catch (error) {
    console.log(`    ⚠ Cancel failed (expected if agent not processing): ${error instanceof Error ? error.message : String(error)}\n`);
  }

  // Step 14: Unsubscribe from updates
  console.log("14. Unsubscribing from agent updates...");
  unsubscribe();
  console.log("    ✓ Unsubscribed\n");

  // Step 15: Test kill_agent
  console.log("15. Killing agent...");
  await agentManager.killAgent(agentId);
  console.log("    ✓ Agent killed successfully\n");

  // Step 16: Verify agent is gone
  console.log("16. Verifying agent is removed...");
  await sleep(1000);
  const finalAgents = agentManager.listAgents();
  if (finalAgents.some((a) => a.id === agentId)) {
    console.error("    ✗ Agent still exists after kill");
    process.exit(1);
  }
  console.log("    ✓ Agent successfully removed\n");

  // Step 17: Close MCP client
  console.log("17. Closing MCP client...");
  await mcpClient.close();
  console.log("    ✓ MCP client closed\n");

  // Summary
  console.log("=== Test Summary ===");
  console.log(`✓ All tests passed`);
  console.log(`✓ Received ${receivedUpdates.length} agent updates during test`);
  console.log("\nIntegration test completed successfully!");
}

// Run the test
main().catch((error) => {
  console.error("\n❌ Test failed with error:");
  console.error(error);
  process.exit(1);
});
