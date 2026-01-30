import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

// Use gpt-5.1-codex-mini with low reasoning effort for faster test execution
const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  describe("timestamp behavior", () => {
    test(
      "opening agent without interaction does not update timestamp",
      async () => {
        const cwd = tmpCwd();

        // Create a Codex agent
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Timestamp Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Record the initial updatedAt timestamp
        const initialUpdatedAt = agent.updatedAt;
        expect(initialUpdatedAt).toBeTruthy();

        // Wait a bit to ensure any timestamp update would be visible
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Clear message queue before the "click" action
        ctx.client.clearMessageQueue();

        // Simulate clicking on the agent (initialize_agent_request)
        // This is what happens when the user opens an agent in the UI
        const refreshedState = await ctx.client.initializeAgent(agent.id);

        // Verify agent is still idle
        expect(refreshedState.status).toBe("idle");

        // CRITICAL: The timestamp should NOT have changed
        // Just opening/clicking an agent should not update its updatedAt
        expect(refreshedState.updatedAt).toBe(initialUpdatedAt);

        // Also clear attention (what happens when opening an agent with notification)
        await ctx.client.clearAgentAttention(agent.id);

        // Get the state again after clearing attention
        const stateAfterClear = await ctx.client.initializeAgent(agent.id);

        // Timestamp should STILL not have changed
        expect(stateAfterClear.updatedAt).toBe(initialUpdatedAt);

        // Cleanup
        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );

    test(
      "sending message DOES update timestamp",
      async () => {
        const cwd = tmpCwd();

        // Create a Codex agent
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Timestamp Update Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Record the initial updatedAt timestamp
        const initialUpdatedAt = new Date(agent.updatedAt);

        // Wait a bit to ensure timestamp difference is visible
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Send a message (this SHOULD update the timestamp)
        await ctx.client.sendMessage(agent.id, "Say 'test' and nothing else");

        // Wait for agent to complete
        const finalState = await ctx.client.waitForFinish(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // The timestamp SHOULD have been updated (should be later than initial)
        const finalUpdatedAt = new Date(finalState.updatedAt);
        expect(finalUpdatedAt.getTime()).toBeGreaterThan(initialUpdatedAt.getTime());

        // Cleanup
        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );
  });


  describe("cancelAgent", () => {
    test(
      "cancels a running agent mid-execution",
      async () => {
        const cwd = tmpCwd();

        // Create Codex agent
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Cancel Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that triggers a long-running operation
        await ctx.client.sendMessage(agent.id, "Run: sleep 30");

        // Wait for the agent to start running (tool call starts)
        let sawRunning = false;
        const startPosition = ctx.client.getMessageQueue().length;

        // Wait for running state
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Timeout waiting for agent to start running"));
          }, 30000);

          const checkForRunning = (): void => {
            const queue = ctx.client.getMessageQueue();
            for (let i = startPosition; i < queue.length; i++) {
              const msg = queue[i];
              if (
                msg.type === "agent_update" &&
                msg.payload.kind === "upsert" &&
                msg.payload.agent.id === agent.id
              ) {
                if (msg.payload.agent.status === "running") {
                  sawRunning = true;
                  clearTimeout(timeout);
                  resolve();
                  return;
                }
              }
            }
          };

          // Check periodically
          const interval = setInterval(checkForRunning, 50);
          const cleanup = (): void => {
            clearInterval(interval);
            clearTimeout(timeout);
          };

          // Override reject to cleanup
          const originalReject = reject;
          reject = (err): void => {
            cleanup();
            originalReject(err);
          };
        });

        expect(sawRunning).toBe(true);

        // Record timestamp before cancel
        const cancelStart = Date.now();

        // Cancel the agent
        await ctx.client.cancelAgent(agent.id);

        // Wait for agent to reach idle or error state
        const finalState = await new Promise<AgentSnapshotPayload>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(
                new Error(
                  "Timeout waiting for agent to stop after cancel (>2 seconds)"
                )
              );
            }, 5000); // Give extra margin, but test should complete in 2s

            const queueStart = ctx.client.getMessageQueue().length;
            const checkForStopped = (): void => {
              const queue = ctx.client.getMessageQueue();
              for (let i = queueStart; i < queue.length; i++) {
                const msg = queue[i];
                if (
                  msg.type === "agent_update" &&
                  msg.payload.kind === "upsert" &&
                  msg.payload.agent.id === agent.id
                ) {
                  if (
                    msg.payload.agent.status === "idle" ||
                    msg.payload.agent.status === "error"
                  ) {
                    clearTimeout(timeout);
                    clearInterval(interval);
                    resolve(msg.payload.agent);
                    return;
                  }
                }
              }
            };

            const interval = setInterval(checkForStopped, 50);
          }
        );

        // Calculate how long the cancel took
        const cancelDuration = Date.now() - cancelStart;

        // Verify agent stopped within reasonable time (2 seconds)
        expect(cancelDuration).toBeLessThan(2000);

        // Verify agent is now idle or error
        expect(["idle", "error"]).toContain(finalState.status);

        // Verify no zombie sleep processes left (check for sleep 30)
        const { execSync } = await import("child_process");
        try {
          const result = execSync("pgrep -f 'sleep 30'", {
            encoding: "utf8",
            timeout: 2000,
          });
          // If pgrep succeeds, there are zombie processes
          if (result.trim()) {
            // Kill them and fail the test
            execSync("pkill -f 'sleep 30'");
            expect.fail("Found zombie sleep processes after cancel");
          }
        } catch {
          // pgrep returns non-zero when no processes found - this is expected
        }

        // Cleanup
        rmSync(cwd, { recursive: true, force: true });
      },
      60000
    );
  });


  describe("setAgentMode", () => {
    test(
      "switches agent mode and persists across messages",
      async () => {
        const cwd = tmpCwd();

        // Create a Codex agent with default mode ("auto")
        const agent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd,
          title: "Mode Switch Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Verify initial mode is "auto" (the default)
        expect(agent.currentModeId).toBe("auto");

        // Clear message queue before mode switch
        ctx.client.clearMessageQueue();
        const startPosition = ctx.client.getMessageQueue().length;

        // Switch to "read-only" mode
        await ctx.client.setAgentMode(agent.id, "read-only");

        // Wait for agent_update upsert reflecting the new mode
        const stateAfterModeSwitch = await new Promise<AgentSnapshotPayload>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error("Timeout waiting for mode change in agent_update"));
            }, 10000);

            const checkForModeChange = (): void => {
              const queue = ctx.client.getMessageQueue();
              for (let i = startPosition; i < queue.length; i++) {
                const msg = queue[i];
                if (
                  msg.type === "agent_update" &&
                  msg.payload.kind === "upsert" &&
                  msg.payload.agent.id === agent.id &&
                  msg.payload.agent.currentModeId === "read-only"
                ) {
                  clearTimeout(timeout);
                  clearInterval(interval);
                  resolve(msg.payload.agent);
                  return;
                }
              }
            };

            const interval = setInterval(checkForModeChange, 50);
          }
        );

        // Verify mode changed to "read-only"
        expect(stateAfterModeSwitch.currentModeId).toBe("read-only");

        // Now verify the mode persists: send a message and check the mode is still "read-only"
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(agent.id, "Say 'hello' and nothing else");

        const finalState = await ctx.client.waitForFinish(agent.id, 120000);

        // Mode should still be "read-only" after the message
        expect(finalState.currentModeId).toBe("read-only");

        // Also verify runtimeInfo has the updated modeId
        expect(finalState.runtimeInfo?.modeId).toBe("read-only");

        // Switch to another mode: "full-access"
        ctx.client.clearMessageQueue();
        const position2 = ctx.client.getMessageQueue().length;

        await ctx.client.setAgentMode(agent.id, "full-access");

        // Wait for agent_update upsert
        const stateAfterFullAccess = await new Promise<AgentSnapshotPayload>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error("Timeout waiting for full-access mode change"));
            }, 10000);

            const checkForModeChange = (): void => {
              const queue = ctx.client.getMessageQueue();
              for (let i = position2; i < queue.length; i++) {
                const msg = queue[i];
                if (
                  msg.type === "agent_update" &&
                  msg.payload.kind === "upsert" &&
                  msg.payload.agent.id === agent.id &&
                  msg.payload.agent.currentModeId === "full-access"
                ) {
                  clearTimeout(timeout);
                  clearInterval(interval);
                  resolve(msg.payload.agent);
                  return;
                }
              }
            };

            const interval = setInterval(checkForModeChange, 50);
          }
        );

        expect(stateAfterFullAccess.currentModeId).toBe("full-access");

        // Cleanup
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout
    );
  });


  describe("listAgents", () => {
    test(
      "returns current agents and reflects create/delete operations",
      async () => {
        const cwd1 = tmpCwd();
        const cwd2 = tmpCwd();

        // Initially, there should be no agents (fresh session)
        const initialAgents = ctx.client.listAgents();
        expect(initialAgents).toHaveLength(0);

        // Create first agent
        const agent1 = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd: cwd1,
          title: "List Test Agent 1",
        });

        expect(agent1.id).toBeTruthy();
        expect(agent1.status).toBe("idle");

        // listAgents should now return 1 agent
        const afterFirst = ctx.client.listAgents();
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0].id).toBe(agent1.id);
        // Title may or may not be set depending on timing
        expect(afterFirst[0].cwd).toBe(cwd1);

        // Create second agent
        const agent2 = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
          cwd: cwd2,
          title: "List Test Agent 2",
        });

        expect(agent2.id).toBeTruthy();
        expect(agent2.status).toBe("idle");

        // listAgents should now return 2 agents
        const afterSecond = ctx.client.listAgents();
        expect(afterSecond).toHaveLength(2);

        // Verify both agents are present with correct IDs and states
        const ids = afterSecond.map((a) => a.id);
        expect(ids).toContain(agent1.id);
        expect(ids).toContain(agent2.id);

        const agent1State = afterSecond.find((a) => a.id === agent1.id);
        const agent2State = afterSecond.find((a) => a.id === agent2.id);

        // Title may or may not be set depending on timing
        expect(agent1State?.cwd).toBe(cwd1);
        expect(agent1State?.status).toBe("idle");

        // Title may or may not be set depending on timing
        expect(agent2State?.cwd).toBe(cwd2);
        expect(agent2State?.status).toBe("idle");

        // Delete first agent
        await ctx.client.deleteAgent(agent1.id);

        // listAgents should now return only 1 agent
        const afterDelete = ctx.client.listAgents();
        expect(afterDelete).toHaveLength(1);
        expect(afterDelete[0].id).toBe(agent2.id);
        expect(afterDelete[0].cwd).toBe(cwd2);

        // Verify agent1 is no longer in the list
        const deletedAgent = afterDelete.find((a) => a.id === agent1.id);
        expect(deletedAgent).toBeUndefined();

        // Cleanup
        await ctx.client.deleteAgent(agent2.id);
        rmSync(cwd1, { recursive: true, force: true });
        rmSync(cwd2, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });


});
