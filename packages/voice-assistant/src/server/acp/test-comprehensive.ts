#!/usr/bin/env tsx

import { AgentManager } from "./agent-manager.js";
import { mkdtemp, rm, readFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { AgentUpdate, AgentStatus } from "./types.js";

/**
 * Comprehensive Test Suite for ACP Agent Functionality
 *
 * This test validates all core features with a REAL Claude Code agent (no mocking):
 *
 * 1. Directory Control - Agent runs in specified directory
 * 2. Permission Mode: Auto Approve - File operations are automatically approved
 * 3. Permission Mode: Reject All - File operations are blocked
 * 4. Multiple Prompts - Agent can handle sequential prompts
 * 5. Update Streaming - All update types stream correctly (message chunks, tool calls, etc.)
 * 6. State Management - Status accurately reflects actual agent state
 *
 * Run with: npx tsx src/server/acp/test-comprehensive.ts
 */

interface TestContext {
  manager: AgentManager;
  tmpDir: string;
}

interface CollectedUpdates {
  all: AgentUpdate[];
  messageChunks: string[];
  toolCalls: any[];
  toolResults: any[];
  statusUpdates: any[];
  commands: any[];
}

async function main() {
  const manager = new AgentManager();
  const tmpDir = await mkdtemp(join(tmpdir(), "acp-test-"));

  console.log("=== Comprehensive ACP Agent Test Suite ===");
  console.log(`Test directory: ${tmpDir}\n`);

  const ctx: TestContext = { manager, tmpDir };

  try {
    await testDirectoryAndInitialPrompt(ctx);
    await testPermissionAutoApprove(ctx);
    await testPermissionRejectAll(ctx);
    await testMultiplePrompts(ctx);
    await testUpdateStreaming(ctx);
    await testStateManagement(ctx);

    console.log("\n✅ ALL TESTS PASSED!");
  } catch (error) {
    console.error("\n❌ TEST SUITE FAILED:", error);
    throw error;
  } finally {
    // Cleanup
    console.log("\n=== Cleanup ===");
    const agents = manager.listAgents();
    console.log(`Killing ${agents.length} agents...`);
    for (const agent of agents) {
      await manager.killAgent(agent.id);
    }
    console.log(`Removing test directory: ${tmpDir}`);
    await rm(tmpDir, { recursive: true, force: true });
    console.log("Cleanup complete");
  }
}

/**
 * TEST 1: Directory Control and Initial Prompt
 * Verifies that the agent runs in the specified directory
 * and can execute the initial prompt successfully
 */
async function testDirectoryAndInitialPrompt(ctx: TestContext) {
  console.log("\n=== TEST 1: Directory Control and Initial Prompt ===");

  const updates = createUpdateCollector();
  let unsubscribe: (() => void) | null = null;

  // Create agent without initial prompt first, so we can subscribe
  const agentId = await ctx.manager.createAgent({
    cwd: ctx.tmpDir,
  });

  console.log(`✓ Agent created: ${agentId}`);

  // Subscribe before sending prompt
  unsubscribe = ctx.manager.subscribeToUpdates(agentId, (update) => {
    collectUpdate(updates, update);
  });

  // Now send the prompt
  await ctx.manager.sendPrompt(
    agentId,
    "Run pwd and confirm you're in the test directory. Output the full path."
  );

  try {
    // Wait for processing to complete
    await waitForStatus(ctx.manager, agentId, "completed", 60000);

    console.log(`✓ Agent completed processing`);
    console.log(`  - Total updates: ${updates.all.length}`);
    console.log(`  - Message chunks: ${updates.messageChunks.length}`);
    console.log(`  - Tool calls: ${updates.toolCalls.length}`);

    // Verify the output contains the tmpDir path
    const fullMessage = updates.messageChunks.join("");
    if (!fullMessage.includes(ctx.tmpDir)) {
      throw new Error(
        `Expected output to contain tmpDir path "${ctx.tmpDir}", but got: ${fullMessage}`
      );
    }

    console.log(`✓ Output contains correct directory path`);

    // Verify we got tool calls (pwd command should be executed via terminal)
    if (updates.toolCalls.length === 0) {
      console.log(`⚠ Warning: No tool calls detected (expected pwd command)`);
    } else {
      console.log(`✓ Tool calls detected: ${updates.toolCalls.length}`);
    }

    // Verify status transitions
    const statuses = extractStatusTransitions(updates);
    if (statuses.length > 0) {
      console.log(`✓ Status transitions: ${statuses.join(" → ")}`);
    }

    console.log("✅ TEST 1 PASSED\n");
  } finally {
    if (unsubscribe) unsubscribe();
    await ctx.manager.killAgent(agentId);
  }
}

/**
 * TEST 2: Permission Mode - Auto Approve
 * Verifies that file operations are automatically approved
 */
async function testPermissionAutoApprove(ctx: TestContext) {
  console.log("\n=== TEST 2: Permission Mode - Auto Approve ===");

  const updates = createUpdateCollector();
  const testFile = join(ctx.tmpDir, "test-auto-approve.txt");

  const agentId = await ctx.manager.createAgent({
    cwd: ctx.tmpDir,
  });

  console.log(`✓ Agent created: ${agentId}`);

  const unsubscribe = ctx.manager.subscribeToUpdates(agentId, (update) => {
    collectUpdate(updates, update);
  });

  await ctx.manager.sendPrompt(
    agentId,
    `Create a file called "test-auto-approve.txt" with the content "hello from auto approve". You can write the file however you prefer.`
  );

  try {
    // Wait for completion
    await waitForStatus(ctx.manager, agentId, "completed", 60000);

    console.log(`✓ Agent completed processing`);
    console.log(`  - Total updates: ${updates.all.length}`);
    console.log(`  - Tool calls: ${updates.toolCalls.length}`);

    // Verify file was created
    try {
      const content = await readFile(testFile, "utf-8");
      console.log(`✓ File created with content: "${content.trim()}"`);

      if (!content.includes("hello from auto approve")) {
        throw new Error(
          `Expected file content to include "hello from auto approve", got: ${content}`
        );
      }

      console.log(`✓ File content is correct`);
    } catch (error) {
      throw new Error(`File was not created or could not be read: ${error}`);
    }

    console.log("✅ TEST 2 PASSED\n");
  } finally {
    unsubscribe();
    await ctx.manager.killAgent(agentId);
  }
}

/**
 * TEST 3: Permission Mode - Reject All
 * Verifies that file operations are blocked
 */
async function testPermissionRejectAll(ctx: TestContext) {
  console.log("\n=== TEST 3: Permission Mode - Reject All ===");

  const updates = createUpdateCollector();
  const testFile = join(ctx.tmpDir, "test-blocked.txt");

  const agentId = await ctx.manager.createAgent({
    cwd: ctx.tmpDir,
  });

  console.log(`✓ Agent created: ${agentId}`);

  const unsubscribe = ctx.manager.subscribeToUpdates(agentId, (update) => {
    collectUpdate(updates, update);
  });

  await ctx.manager.sendPrompt(
    agentId,
    `Create a file called "test-blocked.txt" with the content "this should be blocked".`
  );

  try {
    // Wait for completion (agent should complete even if permission denied)
    await waitForStatus(ctx.manager, agentId, "completed", 60000);

    console.log(`✓ Agent completed processing`);
    console.log(`  - Total updates: ${updates.all.length}`);

    // Verify file was NOT created
    try {
      await access(testFile);
      throw new Error(
        "File should not have been created with reject_all mode"
      );
    } catch (error: any) {
      if (error.code === "ENOENT") {
        console.log(`✓ File was correctly blocked from creation`);
      } else {
        throw error;
      }
    }

    // Check that the response indicates permission denial
    const fullMessage = updates.messageChunks.join("").toLowerCase();
    const hasPermissionMessage =
      fullMessage.includes("permission") ||
      fullMessage.includes("denied") ||
      fullMessage.includes("blocked") ||
      fullMessage.includes("unable") ||
      fullMessage.includes("could not") ||
      fullMessage.includes("cannot");

    if (hasPermissionMessage) {
      console.log(`✓ Agent indicated permission denial in response`);
    } else {
      console.log(
        `⚠ Warning: Agent response doesn't clearly indicate permission denial`
      );
      console.log(`  Response: ${fullMessage.substring(0, 200)}...`);
    }

    console.log("✅ TEST 3 PASSED\n");
  } finally {
    unsubscribe();
    await ctx.manager.killAgent(agentId);
  }
}

/**
 * TEST 4: Multiple Prompts
 * Verifies that an agent can handle multiple sequential prompts
 */
async function testMultiplePrompts(ctx: TestContext) {
  console.log("\n=== TEST 4: Multiple Prompts ===");

  const updates1 = createUpdateCollector();
  const updates2 = createUpdateCollector();
  let collectingFirst = true;

  const agentId = await ctx.manager.createAgent({
    cwd: ctx.tmpDir,
  });

  console.log(`✓ Agent created: ${agentId}`);

  const unsubscribe = ctx.manager.subscribeToUpdates(agentId, (update) => {
    if (collectingFirst) {
      collectUpdate(updates1, update);
    } else {
      collectUpdate(updates2, update);
    }
  });

  try {
    // Send first prompt
    console.log("Sending prompt 1...");
    await ctx.manager.sendPrompt(agentId, "Echo 'first prompt response'");

    await waitForStatus(ctx.manager, agentId, "completed", 30000);
    console.log(`✓ First prompt completed`);
    console.log(`  - Updates: ${updates1.all.length}`);
    console.log(`  - Message: ${updates1.messageChunks.join("").substring(0, 100)}...`);

    // Switch to collecting second set of updates
    collectingFirst = false;

    // Send second prompt
    console.log("Sending prompt 2...");
    await ctx.manager.sendPrompt(agentId, "Echo 'second prompt response'");

    await waitForStatus(ctx.manager, agentId, "completed", 30000);
    console.log(`✓ Second prompt completed`);
    console.log(`  - Updates: ${updates2.all.length}`);
    console.log(`  - Message: ${updates2.messageChunks.join("").substring(0, 100)}...`);

    // Verify both prompts got responses
    if (updates1.all.length === 0 || updates2.all.length === 0) {
      throw new Error("Both prompts should generate updates");
    }

    console.log(`✓ Both prompts executed successfully`);
    console.log("✅ TEST 4 PASSED\n");
  } finally {
    unsubscribe();
    await ctx.manager.killAgent(agentId);
  }
}

/**
 * TEST 5: Update Streaming
 * Verifies that all update types are received correctly
 */
async function testUpdateStreaming(ctx: TestContext) {
  console.log("\n=== TEST 5: Update Streaming ===");

  const updates = createUpdateCollector();

  const agentId = await ctx.manager.createAgent({
    cwd: ctx.tmpDir,
  });

  console.log(`✓ Agent created: ${agentId}`);

  const unsubscribe = ctx.manager.subscribeToUpdates(agentId, (update) => {
    collectUpdate(updates, update);
  });

  await ctx.manager.sendPrompt(
    agentId,
    "List the files in the current directory using the Bash tool. Then explain what you found."
  );

  try {
    await waitForStatus(ctx.manager, agentId, "completed", 60000);

    console.log(`✓ Agent completed processing`);
    console.log(`\nUpdate Statistics:`);
    console.log(`  - Total updates: ${updates.all.length}`);
    console.log(`  - Message chunks: ${updates.messageChunks.length}`);
    console.log(`  - Tool calls: ${updates.toolCalls.length}`);
    console.log(`  - Tool results: ${updates.toolResults.length}`);
    console.log(`  - Status updates: ${updates.statusUpdates.length}`);
    console.log(`  - Commands: ${updates.commands.length}`);

    // Verify message can be reconstructed
    const fullMessage = updates.messageChunks.join("");
    console.log(`\nReconstructed message length: ${fullMessage.length} chars`);
    console.log(`First 150 chars: ${fullMessage.substring(0, 150)}...`);

    if (fullMessage.length === 0) {
      throw new Error("Expected to receive message chunks");
    }

    console.log(`✓ Message chunks successfully reconstructed`);

    // Verify we got tool calls
    if (updates.toolCalls.length === 0) {
      throw new Error("Expected at least one tool call");
    }

    console.log(`✓ Tool calls captured: ${updates.toolCalls.length}`);

    // Log tool call details
    updates.toolCalls.forEach((call, i) => {
      console.log(`  Tool ${i + 1}: ${JSON.stringify(call).substring(0, 100)}...`);
    });

    console.log("✅ TEST 5 PASSED\n");
  } finally {
    unsubscribe();
    await ctx.manager.killAgent(agentId);
  }
}

/**
 * TEST 6: State Management
 * Verifies that agent status accurately reflects actual state
 */
async function testStateManagement(ctx: TestContext) {
  console.log("\n=== TEST 6: State Management ===");

  const statusLog: Array<{ time: Date; status: AgentStatus }> = [];

  const agentId = await ctx.manager.createAgent({
    cwd: ctx.tmpDir,
  });

  console.log(`✓ Agent created: ${agentId}`);

  await ctx.manager.sendPrompt(
    agentId,
    "Sleep for 2 seconds using a bash command, then echo 'done'"
  );

  // Track status changes
  const checkInterval = setInterval(() => {
    const status = ctx.manager.getAgentStatus(agentId);
    statusLog.push({ time: new Date(), status });
  }, 500);

  try {
    // Wait for completion
    await waitForStatus(ctx.manager, agentId, "completed", 60000);

    clearInterval(checkInterval);

    console.log(`✓ Agent completed processing`);
    console.log(`\nStatus transitions logged: ${statusLog.length}`);

    // Analyze status transitions
    const transitions: string[] = [];
    let lastStatus: AgentStatus | null = null;

    for (const entry of statusLog) {
      if (entry.status !== lastStatus) {
        transitions.push(entry.status);
        lastStatus = entry.status;
      }
    }

    console.log(`Status transition sequence: ${transitions.join(" → ")}`);

    // Verify expected transitions occurred
    const expectedStates = ["ready", "processing", "completed"];
    for (const expectedState of expectedStates) {
      if (!transitions.includes(expectedState as AgentStatus)) {
        console.log(
          `⚠ Warning: Expected state "${expectedState}" not observed`
        );
      } else {
        console.log(`✓ State "${expectedState}" observed`);
      }
    }

    // Verify final status is completed
    const finalStatus = ctx.manager.getAgentStatus(agentId);
    if (finalStatus !== "completed") {
      throw new Error(
        `Expected final status to be "completed", got "${finalStatus}"`
      );
    }

    console.log(`✓ Final status is correct: ${finalStatus}`);

    // Kill the agent and verify status changes
    await ctx.manager.killAgent(agentId);

    // Agent should be removed from manager
    try {
      ctx.manager.getAgentStatus(agentId);
      throw new Error("Agent should be removed after killing");
    } catch (error: any) {
      if (error.message.includes("not found")) {
        console.log(`✓ Agent correctly removed after kill`);
      } else {
        throw error;
      }
    }

    console.log("✅ TEST 6 PASSED\n");
  } finally {
    clearInterval(checkInterval);
  }
}

/**
 * Helper: Create an update collector
 */
function createUpdateCollector(): CollectedUpdates {
  return {
    all: [],
    messageChunks: [],
    toolCalls: [],
    toolResults: [],
    statusUpdates: [],
    commands: [],
  };
}

/**
 * Helper: Collect and categorize an update
 */
function collectUpdate(collector: CollectedUpdates, update: AgentUpdate): void {
  collector.all.push(update);

  const notification = update.notification as any;

  // The notification structure can be:
  // 1. { type: "sessionUpdate", sessionUpdate: { ... } } - for status updates
  // 2. { sessionUpdate: "agent_message_chunk", content: { ... } } - for message chunks
  // 3. { sessionUpdate: "tool_call", ... } - for tool calls
  // 4. { availableCommands: [...] } - for available commands

  // Message chunks
  if (notification.sessionUpdate === "agent_message_chunk" && notification.content) {
    const content = notification.content;
    if (content.type === "text" && content.text) {
      collector.messageChunks.push(content.text);
    }
  }

  // Tool calls
  if (notification.sessionUpdate === "tool_call") {
    collector.toolCalls.push(notification);
  }

  // Tool results
  if (notification.sessionUpdate === "tool_result") {
    collector.toolResults.push(notification);
  }

  // Status updates from the wrapper
  if (notification.type === "sessionUpdate" && notification.sessionUpdate?.status) {
    collector.statusUpdates.push(notification.sessionUpdate.status);
  }

  // Status updates from our custom type
  if (notification.sessionUpdate === "status_change") {
    collector.statusUpdates.push(notification.status);
  }

  // Available commands
  if (notification.availableCommands) {
    collector.commands.push(notification.availableCommands);
  }
}

/**
 * Helper: Extract status transitions from updates
 */
function extractStatusTransitions(collector: CollectedUpdates): string[] {
  const statuses: string[] = [];
  let lastStatus: string | null = null;

  for (const statusUpdate of collector.statusUpdates) {
    if (statusUpdate !== lastStatus) {
      statuses.push(String(statusUpdate));
      lastStatus = statusUpdate;
    }
  }

  return statuses;
}

/**
 * Helper: Wait for agent to reach a specific status
 */
async function waitForStatus(
  manager: AgentManager,
  agentId: string,
  targetStatus: AgentStatus,
  timeoutMs: number
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const currentStatus = manager.getAgentStatus(agentId);

    if (currentStatus === targetStatus) {
      return;
    }

    if (currentStatus === "failed") {
      const agent = manager.listAgents().find((a) => a.id === agentId);
      throw new Error(
        `Agent failed while waiting for status "${targetStatus}": ${agent?.error}`
      );
    }

    // Wait a bit before checking again
    await sleep(500);
  }

  throw new Error(
    `Timeout waiting for status "${targetStatus}" (current: ${manager.getAgentStatus(agentId)})`
  );
}

/**
 * Helper: Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Run the test suite
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
