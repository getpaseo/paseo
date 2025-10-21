#!/usr/bin/env tsx

import { AgentManager } from "./agent-manager.js";

async function main() {
  console.log("=== ACP Concurrent Agents Test ===\n");

  const manager = new AgentManager();

  try {
    console.log("1. Creating multiple agents...");
    const agent1Id = await manager.createAgent({
      cwd: process.cwd(),
    });
    const agent2Id = await manager.createAgent({
      cwd: process.cwd(),
    });
    console.log(`   ✓ Agent 1: ${agent1Id}`);
    console.log(`   ✓ Agent 2: ${agent2Id}\n`);

    console.log("2. Setting up update handlers...");
    let agent1Updates = 0;
    let agent2Updates = 0;

    manager.subscribeToUpdates(agent1Id, () => {
      agent1Updates++;
    });

    manager.subscribeToUpdates(agent2Id, () => {
      agent2Updates++;
    });
    console.log("   ✓ Handlers set up\n");

    console.log("3. Sending prompts to both agents...");
    await manager.sendPrompt(agent1Id, "Echo 'Agent 1 says hello'");
    await manager.sendPrompt(agent2Id, "Echo 'Agent 2 says hello'");
    console.log("   ✓ Prompts sent\n");

    console.log("4. Waiting for activity (5 seconds)...");
    await new Promise((resolve) => setTimeout(resolve, 5000));
    console.log(`   Agent 1 updates: ${agent1Updates}`);
    console.log(`   Agent 2 updates: ${agent2Updates}\n`);

    console.log("5. Listing all agents...");
    const agents = manager.listAgents();
    console.log(`   Total agents: ${agents.length}`);
    agents.forEach((agent) => {
      console.log(`   - ${agent.id.slice(0, 8)}: ${agent.status}`);
    });
    console.log();

    console.log("6. Testing cancellation on agent 1...");
    const status1Before = manager.getAgentStatus(agent1Id);
    console.log(`   Agent 1 status before cancel: ${status1Before}`);

    await manager.cancelAgent(agent1Id);
    const status1After = manager.getAgentStatus(agent1Id);
    console.log(`   Agent 1 status after cancel: ${status1After}\n`);

    console.log("7. Cleaning up...");
    await manager.killAgent(agent1Id);
    await manager.killAgent(agent2Id);
    console.log("   ✓ All agents killed\n");

    console.log("8. Verifying cleanup...");
    const remainingAgents = manager.listAgents();
    console.log(`   Remaining agents: ${remainingAgents.length}\n`);

    console.log("=== Concurrent test completed successfully ===");
  } catch (error) {
    console.error("\n❌ Test failed:");
    console.error(error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
