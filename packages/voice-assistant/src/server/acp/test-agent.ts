#!/usr/bin/env tsx

import { AgentManager } from "./agent-manager.js";

async function main() {
  console.log("=== ACP Agent Manager Test ===\n");

  const manager = new AgentManager();

  try {
    console.log("1. Creating agent...");
    const agentId = await manager.createAgent({
      cwd: process.cwd(),
    });
    console.log(`   ✓ Agent created: ${agentId}\n`);

    console.log("2. Subscribing to updates...");
    manager.subscribeToUpdates(agentId, (update) => {
      console.log(`   [UPDATE] ${new Date().toISOString()}`);
      console.log(`   Type: ${(update.notification as any).type}`);
      console.log(`   Notification:`, JSON.stringify(update.notification, null, 2));
      console.log();
    });
    console.log("   ✓ Subscribed\n");

    console.log("3. Checking initial status...");
    const status = manager.getAgentStatus(agentId);
    console.log(`   Status: ${status}\n`);

    console.log("4. Listing all agents...");
    const agents = manager.listAgents();
    console.log(`   Total agents: ${agents.length}`);
    agents.forEach((agent) => {
      console.log(
        `   - ${agent.id}: ${agent.status} (created: ${agent.createdAt.toISOString()})`
      );
    });
    console.log();

    console.log("5. Sending prompt: 'List files in current directory'");
    await manager.sendPrompt(
      agentId,
      "List files in current directory using ls"
    );
    console.log("   ✓ Prompt sent\n");

    console.log("6. Waiting for completion (30 seconds max)...");
    const startTime = Date.now();
    const maxWait = 30000; // 30 seconds

    await new Promise<void>((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const currentStatus = manager.getAgentStatus(agentId);
        const elapsed = Date.now() - startTime;

        if (currentStatus === "completed") {
          clearInterval(checkInterval);
          console.log(`   ✓ Agent completed in ${elapsed}ms\n`);
          resolve();
        } else if (currentStatus === "failed") {
          clearInterval(checkInterval);
          const agents = manager.listAgents();
          const agent = agents.find((a) => a.id === agentId);
          reject(new Error(`Agent failed: ${agent?.error || "Unknown error"}`));
        } else if (elapsed > maxWait) {
          clearInterval(checkInterval);
          console.log(`   ⚠ Timeout after ${elapsed}ms (status: ${currentStatus})\n`);
          resolve();
        }
      }, 500);
    });

    console.log("7. Cleaning up...");
    await manager.killAgent(agentId);
    console.log("   ✓ Agent killed\n");

    console.log("=== Test completed successfully ===");
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
