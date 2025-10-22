#!/usr/bin/env tsx

import { AgentManager } from "./agent-manager.js";

async function main() {
  console.log("=== ACP Simple Test ===\n");

  const manager = new AgentManager();
  let updateCount = 0;
  let toolCallCount = 0;
  let messageChunks: string[] = [];

  try {
    console.log("1. Creating agent...");
    const agentId = await manager.createAgent({
      cwd: process.cwd(),
    });
    console.log(`   ✓ Created: ${agentId}\n`);

    console.log("2. Setting up minimal update handler...");
    manager.subscribeToUpdates(agentId, (update) => {
      updateCount++;
      const sessionUpdate = (update.notification as any).sessionUpdate;

      if (sessionUpdate === "tool_call") {
        toolCallCount++;
        console.log(`   [Tool Call] ${(update.notification as any).title}`);
      } else if (sessionUpdate === "agent_message_chunk") {
        const text = (update.notification as any).content?.text || "";
        if (text.trim()) {
          messageChunks.push(text);
        }
      }
    });
    console.log("   ✓ Handler set up\n");

    console.log("3. Sending prompt...");
    await manager.sendPrompt(agentId, "List 3 files in current directory");
    console.log("   ✓ Prompt sent\n");

    console.log("4. Waiting for completion (10 seconds)...");
    await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log("\n=== Results ===");
    console.log(`Total updates: ${updateCount}`);
    console.log(`Tool calls: ${toolCallCount}`);
    console.log(`Message length: ${messageChunks.join("").length} chars`);
    console.log(`First few chunks: ${messageChunks.slice(0, 5).join("")}\n`);

    console.log("5. Cleaning up...");
    await manager.killAgent(agentId);
    console.log("   ✓ Agent killed\n");

    console.log("=== Simple test completed ===");
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
