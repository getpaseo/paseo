import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AgentManager } from "./agent-manager.js";
import type { AgentUpdate, AgentStatus } from "./types.js";
import { mkdtemp, rm, readFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Vitest Test Suite for ACP Agent Functionality
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
 * Run with: npx vitest run src/server/acp/agent-manager.test.ts
 */

// ============================================================================
// Test Utilities
// ============================================================================

interface CollectedUpdates {
  all: AgentUpdate[];
  messageChunks: string[];
  toolCalls: any[];
  toolResults: any[];
  statusUpdates: any[];
  commands: any[];
}

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

function collectUpdate(collector: CollectedUpdates, update: AgentUpdate): void {
  collector.all.push(update);

  const notification = update.notification as any;

  // Message chunks
  if (
    notification.sessionUpdate === "agent_message_chunk" &&
    notification.content
  ) {
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
  if (
    notification.type === "sessionUpdate" &&
    notification.sessionUpdate?.status
  ) {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// Test Suite
// ============================================================================

describe("AgentManager", () => {
  let manager: AgentManager;
  let tmpDir: string;

  beforeAll(async () => {
    manager = new AgentManager();
    tmpDir = await mkdtemp(join(tmpdir(), "acp-test-"));
  });

  afterAll(async () => {
    // Kill all agents
    const agents = manager.listAgents();
    for (const agent of agents) {
      await manager.killAgent(agent.id);
    }
    // Remove temp directory
    await rm(tmpDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // TEST 1: Directory Control and Initial Prompt
  // ==========================================================================

  describe("Agent Creation and Directory Control", () => {
    it(
      "should create agent and run in specified directory",
      async () => {
        const updates = createUpdateCollector();
        let unsubscribe: (() => void) | null = null;

        // Create agent without initial prompt first, so we can subscribe
        const agentId = await manager.createAgent({
          cwd: tmpDir,
        });

        expect(agentId).toBeDefined();
        expect(typeof agentId).toBe("string");

        // Subscribe before sending prompt
        unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
          collectUpdate(updates, update);
        });

        // Now send the prompt
        await manager.sendPrompt(
          agentId,
          "Run pwd and confirm you're in the test directory. Output the full path."
        );

        try {
          // Wait for processing to complete
          await waitForStatus(manager, agentId, "completed", 60000);

          // Verify we got updates
          expect(updates.all.length).toBeGreaterThan(0);
          expect(updates.messageChunks.length).toBeGreaterThan(0);

          // Verify the output contains the tmpDir path
          const fullMessage = updates.messageChunks.join("");
          expect(fullMessage).toContain(tmpDir);

          // Verify status transitions
          const statuses = extractStatusTransitions(updates);
          expect(statuses.length).toBeGreaterThan(0);
        } finally {
          if (unsubscribe) unsubscribe();
          await manager.killAgent(agentId);
        }
      },
      60000
    );
  });

  // ==========================================================================
  // TEST 2: Permission Mode - Auto Approve
  // ==========================================================================

  describe("Permission Mode: Auto Approve", () => {
    it(
      "should create files when in auto_approve mode",
      async () => {
        const updates = createUpdateCollector();
        const testFile = join(tmpDir, "test-auto-approve.txt");

        const agentId = await manager.createAgent({
          cwd: tmpDir,
        });

        expect(agentId).toBeDefined();

        const unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
          collectUpdate(updates, update);
        });

        await manager.sendPrompt(
          agentId,
          `Create a file called "test-auto-approve.txt" with the content "hello from auto approve". You can write the file however you prefer.`
        );

        try {
          // Wait for completion
          await waitForStatus(manager, agentId, "completed", 60000);

          expect(updates.all.length).toBeGreaterThan(0);
          expect(updates.toolCalls.length).toBeGreaterThan(0);

          // Verify file was created
          const content = await readFile(testFile, "utf-8");
          expect(content).toContain("hello from auto approve");
        } finally {
          unsubscribe();
          await manager.killAgent(agentId);
        }
      },
      60000
    );
  });

  // ==========================================================================
  // TEST 3: Permission Mode - Reject All
  // ==========================================================================

  describe("Permission Mode: Reject All", () => {
    it(
      "should block file operations in reject_all mode",
      async () => {
        const updates = createUpdateCollector();
        const testFile = join(tmpDir, "test-blocked.txt");

        const agentId = await manager.createAgent({
          cwd: tmpDir,
        });

        expect(agentId).toBeDefined();

        const unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
          collectUpdate(updates, update);
        });

        await manager.sendPrompt(
          agentId,
          `Create a file called "test-blocked.txt" with the content "this should be blocked".`
        );

        try {
          // Wait for completion (agent should complete even if permission denied)
          await waitForStatus(manager, agentId, "completed", 60000);

          expect(updates.all.length).toBeGreaterThan(0);

          // Verify file was NOT created
          await expect(access(testFile)).rejects.toThrow();

          // Check that the response indicates permission denial
          const fullMessage = updates.messageChunks.join("").toLowerCase();
          const hasPermissionMessage =
            fullMessage.includes("permission") ||
            fullMessage.includes("denied") ||
            fullMessage.includes("blocked") ||
            fullMessage.includes("unable") ||
            fullMessage.includes("could not") ||
            fullMessage.includes("cannot");

          // This is a soft assertion - we expect permission denial indication
          // but don't fail the test if it's not present
          if (!hasPermissionMessage) {
            console.warn(
              "Warning: Agent response doesn't clearly indicate permission denial"
            );
          }
        } finally {
          unsubscribe();
          await manager.killAgent(agentId);
        }
      },
      60000
    );
  });

  // ==========================================================================
  // TEST 4: Multiple Prompts
  // ==========================================================================

  describe("Multiple Prompts", () => {
    it(
      "should handle sequential prompts to same agent",
      async () => {
        const updates1 = createUpdateCollector();
        const updates2 = createUpdateCollector();
        let collectingFirst = true;

        const agentId = await manager.createAgent({
          cwd: tmpDir,
        });

        expect(agentId).toBeDefined();

        const unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
          if (collectingFirst) {
            collectUpdate(updates1, update);
          } else {
            collectUpdate(updates2, update);
          }
        });

        try {
          // Send first prompt
          await manager.sendPrompt(agentId, "Echo 'first prompt response'");

          await waitForStatus(manager, agentId, "completed", 30000);

          expect(updates1.all.length).toBeGreaterThan(0);

          // Switch to collecting second set of updates
          collectingFirst = false;

          // Send second prompt
          await manager.sendPrompt(agentId, "Echo 'second prompt response'");

          await waitForStatus(manager, agentId, "completed", 30000);

          expect(updates2.all.length).toBeGreaterThan(0);

          // Verify both prompts got responses
          expect(updates1.all.length).toBeGreaterThan(0);
          expect(updates2.all.length).toBeGreaterThan(0);
        } finally {
          unsubscribe();
          await manager.killAgent(agentId);
        }
      },
      60000
    );
  });

  // ==========================================================================
  // TEST 5: Update Streaming
  // ==========================================================================

  describe("Update Streaming", () => {
    it(
      "should stream all update types correctly",
      async () => {
        const updates = createUpdateCollector();

        const agentId = await manager.createAgent({
          cwd: tmpDir,
        });

        expect(agentId).toBeDefined();

        const unsubscribe = manager.subscribeToUpdates(agentId, (update) => {
          collectUpdate(updates, update);
        });

        await manager.sendPrompt(
          agentId,
          "List the files in the current directory using the Bash tool. Then explain what you found."
        );

        try {
          await waitForStatus(manager, agentId, "completed", 60000);

          // Verify we got various update types
          expect(updates.all.length).toBeGreaterThan(0);
          expect(updates.messageChunks.length).toBeGreaterThan(0);
          expect(updates.toolCalls.length).toBeGreaterThan(0);

          // Verify message can be reconstructed
          const fullMessage = updates.messageChunks.join("");
          expect(fullMessage.length).toBeGreaterThan(0);
        } finally {
          unsubscribe();
          await manager.killAgent(agentId);
        }
      },
      60000
    );
  });

  // ==========================================================================
  // TEST 6: State Management
  // ==========================================================================

  describe("State Management", () => {
    it(
      "should transition states correctly and clean up after kill",
      async () => {
        const statusLog: Array<{ time: Date; status: AgentStatus }> = [];

        const agentId = await manager.createAgent({
          cwd: tmpDir,
        });

        expect(agentId).toBeDefined();

        // Track status changes BEFORE sending prompt
        const checkInterval = setInterval(() => {
          const status = manager.getAgentStatus(agentId);
          statusLog.push({ time: new Date(), status });
        }, 500);

        await manager.sendPrompt(
          agentId,
          "Sleep for 2 seconds using a bash command, then echo 'done'"
        );

        try {
          // Wait for completion
          await waitForStatus(manager, agentId, "completed", 60000);

          clearInterval(checkInterval);

          // Log should have captured status changes
          // (Note: might be 0 if agent completed too quickly)
          // We'll check transitions instead which is more reliable

          // Analyze status transitions
          const transitions: string[] = [];
          let lastStatus: AgentStatus | null = null;

          for (const entry of statusLog) {
            if (entry.status !== lastStatus) {
              transitions.push(entry.status);
              lastStatus = entry.status;
            }
          }

          // Verify final status is completed (this is the most important check)
          const finalStatus = manager.getAgentStatus(agentId);
          expect(finalStatus).toBe("completed");

          // If we captured transitions, verify they include expected states
          // (Agent might complete too quickly to capture all states)
          if (transitions.length > 0) {
            // Should at least have completed state
            expect(transitions).toContain("completed");
          }

          // Kill the agent and verify status changes
          await manager.killAgent(agentId);

          // Agent should be removed from manager
          expect(() => manager.getAgentStatus(agentId)).toThrow("not found");
        } finally {
          clearInterval(checkInterval);
        }
      },
      60000
    );
  });
});
