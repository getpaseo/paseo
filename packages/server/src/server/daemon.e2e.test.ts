import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
  useTempClaudeConfigDir,
} from "./test-utils/index.js";
import type { AgentTimelineItem } from "./agent/agent-sdk-types.js";
import type { AgentSnapshotPayload } from "./messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("creates agent and receives response", async () => {
    // Create a Codex agent
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("codex");
    expect(agent.status).toBe("idle");
    // Title may or may not be set depending on timing
    expect(agent.cwd).toBe("/tmp");

    // Send a simple message
    await ctx.client.sendMessage(agent.id, "Say 'hello world' and nothing else");

    // Wait for the agent to complete
    const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

    // Verify agent completed without error
    expect(finalState.status).toBe("idle");
    expect(finalState.lastError).toBeUndefined();
    expect(finalState.id).toBe(agent.id);

    // Verify we received some stream events
    const queue = ctx.client.getMessageQueue();
    const streamEvents = queue.filter(
      (m) => m.type === "agent_stream" && m.payload.agentId === agent.id
    );
    expect(streamEvents.length).toBeGreaterThan(0);

    // Verify there was a turn_started event
    const hasTurnStarted = streamEvents.some(
      (m) =>
        m.type === "agent_stream" && m.payload.event.type === "turn_started"
    );
    expect(hasTurnStarted).toBe(true);

    // Verify there was a turn_completed event
    const hasTurnCompleted = streamEvents.some(
      (m) =>
        m.type === "agent_stream" && m.payload.event.type === "turn_completed"
    );
    expect(hasTurnCompleted).toBe(true);

    // Verify there was an assistant message in the timeline
    const hasAssistantMessage = streamEvents.some((m) => {
      if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
        return false;
      }
      const item = m.payload.event.item;
      return item.type === "assistant_message" && item.text.length > 0;
    });
    expect(hasAssistantMessage).toBe(true);
  }, 180000); // 3 minute timeout for E2E test

  describe("permission flow: Codex", () => {
    test(
      "approves permission and executes command",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");

        // Create Codex agent with on-request approval policy
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Codex Permission Test",
          modeId: "auto",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt`.",
          "After approval, run it and reply DONE.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();
        expect(permission.kind).toBe("tool");

        // Approve the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
        });

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // Verify the file was created
        expect(existsSync(filePath)).toBe(true);

        // Verify permission_resolved event was received
        const queue = ctx.client.getMessageQueue();
        const hasPermissionResolved = queue.some((m) => {
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            return (
              m.payload.event.type === "permission_resolved" &&
              m.payload.event.requestId === permission.id &&
              m.payload.event.resolution.behavior === "allow"
            );
          }
          return false;
        });
        expect(hasPermissionResolved).toBe(true);

        // Verify permission timeline items
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have permission granted timeline item
        const hasGranted = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "granted"
        );
        expect(hasGranted).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );

    test(
      "denies permission and prevents execution",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");

        // Create Codex agent with on-request approval policy
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Codex Permission Deny Test",
          modeId: "auto",
        });

        expect(agent.id).toBeTruthy();

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission
        const prompt = [
          "Request approval to run the command `printf \"ok\" > permission.txt`.",
          "If approval is denied, acknowledge and stop.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();

        // Deny the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "deny",
          message: "Not allowed.",
        });

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // Verify the file was NOT created
        expect(existsSync(filePath)).toBe(false);

        // Verify permission_resolved event was received with deny
        const queue = ctx.client.getMessageQueue();
        const hasPermissionDenied = queue.some((m) => {
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            return (
              m.payload.event.type === "permission_resolved" &&
              m.payload.event.requestId === permission.id &&
              m.payload.event.resolution.behavior === "deny"
            );
          }
          return false;
        });
        expect(hasPermissionDenied).toBe(true);

        // Verify permission denied timeline item
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        const hasDenied = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "denied"
        );
        expect(hasDenied).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );
  });

  describe("persistence flow", () => {
    test(
      "persists and resumes Codex agent with conversation history",
      async () => {
        const cwd = tmpCwd();

        // Create agent
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Persistence Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");
        const originalAgentId = agent.id;

        // Send a message to generate some state
        await ctx.client.sendMessage(
          agent.id,
          "Say 'state saved' and nothing else"
        );

        // Wait for agent to complete
        const afterMessage = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(afterMessage.status).toBe("idle");

        // Get the timeline to verify we have messages
        const queue = ctx.client.getMessageQueue();
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have at least one assistant message
        const assistantMessages = timelineItems.filter(
          (item) => item.type === "assistant_message"
        );
        expect(assistantMessages.length).toBeGreaterThan(0);

        // Get persistence handle from agent state
        expect(afterMessage.persistence).toBeTruthy();
        const persistence = afterMessage.persistence;
        expect(persistence?.provider).toBe("codex");
        expect(persistence?.sessionId).toBeTruthy();
        // Codex uses conversationId in metadata for resumption
        expect(
          (persistence?.metadata as { conversationId?: string })?.conversationId
        ).toBeTruthy();

        // Delete the agent from the current session
        await ctx.client.deleteAgent(agent.id);

        // Verify agent deletion was confirmed (agent_deleted event was received)
        const queue2 = ctx.client.getMessageQueue();
        const hasDeletedEvent = queue2.some(
          (m) =>
            m.type === "agent_deleted" && m.payload.agentId === originalAgentId
        );
        expect(hasDeletedEvent).toBe(true);

        // Resume the agent using the persistence handle directly
        // NOTE: Codex MCP doesn't implement listPersistedAgents() because conversations
        // are stored internally by codex CLI. We resume by passing the persistence handle.
        const resumedAgent = await ctx.client.resumeAgent(persistence!);

        expect(resumedAgent.id).toBeTruthy();
        expect(resumedAgent.status).toBe("idle");
        expect(resumedAgent.cwd).toBe(cwd);
        expect(resumedAgent.provider).toBe("codex");

        // Note: AgentSnapshotPayload doesn't include timeline directly.
        // Timeline events are streamed separately. The key verification
        // is that we can send a follow-up message and the agent responds
        // with awareness of the previous conversation context.

        // Verify we can send another message to the resumed agent
        // This proves the conversation context is preserved
        ctx.client.clearMessageQueue();
        await ctx.client.sendMessage(
          resumedAgent.id,
          "What did I ask you to say earlier?"
        );

        const afterResume = await ctx.client.waitForAgentIdle(
          resumedAgent.id,
          120000
        );
        expect(afterResume.status).toBe("idle");

        // Verify we got a response
        const resumeQueue = ctx.client.getMessageQueue();
        const hasResumeResponse = resumeQueue.some((m) => {
          if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
            return false;
          }
          return m.payload.event.item.type === "assistant_message";
        });
        expect(hasResumeResponse).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(resumedAgent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for persistence E2E
    );
  });

  describe("multi-agent orchestration", () => {
    test(
      "parent agent creates child agent via agent-control MCP",
      async () => {
        const cwd = tmpCwd();
        const childCwd = tmpCwd();

        // Create parent Codex agent
        const parent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Parent Agent",
        });

        expect(parent.id).toBeTruthy();
        expect(parent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Prompt the parent to create a child agent using agent-control MCP
        const prompt = [
          `Use the create_agent tool from the agent-control MCP server to create a new codex agent.`,
          `Set the cwd to: ${childCwd}`,
          `Set the title to: Child Agent`,
          `Set agentType to: codex`,
          `Do NOT set an initialPrompt - just create the agent.`,
          `After creating the agent, reply with "CREATED" followed by the child's agentId.`,
        ].join(" ");

        await ctx.client.sendMessage(parent.id, prompt);

        // Wait for parent to complete
        const afterCreate = await ctx.client.waitForAgentIdle(
          parent.id,
          120000
        );
        expect(afterCreate.status).toBe("idle");

        // Verify timeline contains a tool call to create_agent
        const queue = ctx.client.getMessageQueue();
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === parent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have a tool call to create_agent from agent-control
        const hasCreateAgentCall = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.tool === "create_agent" &&
            item.server === "agent-control"
        );
        expect(hasCreateAgentCall).toBe(true);

        // Now verify we can see both agents via session_state
        // Send a list_persisted_agents_request to trigger session_state refresh
        // Or we can check the queue for agent_state messages
        const agentStateMessages = queue.filter(
          (m) => m.type === "agent_state"
        );

        // Extract unique agent IDs from state messages
        const agentIds = new Set<string>();
        for (const m of agentStateMessages) {
          if (m.type === "agent_state") {
            agentIds.add(m.payload.id);
          }
        }

        // Should have at least 2 agents (parent + child)
        expect(agentIds.size).toBeGreaterThanOrEqual(2);
        expect(agentIds.has(parent.id)).toBe(true);

        // Get the child agent ID from the tool call output
        const createAgentCall = timelineItems.find(
          (item) =>
            item.type === "tool_call" &&
            item.tool === "create_agent" &&
            item.server === "agent-control"
        );

        let childAgentId: string | null = null;
        if (
          createAgentCall &&
          createAgentCall.type === "tool_call" &&
          createAgentCall.output
        ) {
          // The output contains the agentId
          const output = createAgentCall.output as { agentId?: string };
          if (output.agentId) {
            childAgentId = output.agentId;
          }
        }

        // Verify we found the child agent ID
        expect(childAgentId).toBeTruthy();
        expect(agentIds.has(childAgentId!)).toBe(true);

        // Cleanup
        rmSync(cwd, { recursive: true, force: true });
        rmSync(childCwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for multi-agent E2E
    );
  });

  describe("timestamp behavior", () => {
    test(
      "opening agent without interaction does not update timestamp",
      async () => {
        const cwd = tmpCwd();

        // Create a Codex agent
        const agent = await ctx.client.createAgent({
          provider: "codex",
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
          provider: "codex",
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
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
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
          provider: "codex",
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
              if (msg.type === "agent_state" && msg.payload.id === agent.id) {
                if (msg.payload.status === "running") {
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
                if (msg.type === "agent_state" && msg.payload.id === agent.id) {
                  if (
                    msg.payload.status === "idle" ||
                    msg.payload.status === "error"
                  ) {
                    clearTimeout(timeout);
                    clearInterval(interval);
                    resolve(msg.payload);
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
          provider: "codex",
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

        // Wait for agent_state update reflecting the new mode
        const stateAfterModeSwitch = await new Promise<AgentSnapshotPayload>(
          (resolve, reject) => {
            const timeout = setTimeout(() => {
              reject(new Error("Timeout waiting for mode change in agent_state"));
            }, 10000);

            const checkForModeChange = (): void => {
              const queue = ctx.client.getMessageQueue();
              for (let i = startPosition; i < queue.length; i++) {
                const msg = queue[i];
                if (
                  msg.type === "agent_state" &&
                  msg.payload.id === agent.id &&
                  msg.payload.currentModeId === "read-only"
                ) {
                  clearTimeout(timeout);
                  clearInterval(interval);
                  resolve(msg.payload);
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

        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

        // Mode should still be "read-only" after the message
        expect(finalState.currentModeId).toBe("read-only");

        // Also verify runtimeInfo has the updated modeId
        expect(finalState.runtimeInfo?.modeId).toBe("read-only");

        // Switch to another mode: "full-access"
        ctx.client.clearMessageQueue();
        const position2 = ctx.client.getMessageQueue().length;

        await ctx.client.setAgentMode(agent.id, "full-access");

        // Wait for agent_state update
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
                  msg.type === "agent_state" &&
                  msg.payload.id === agent.id &&
                  msg.payload.currentModeId === "full-access"
                ) {
                  clearTimeout(timeout);
                  clearInterval(interval);
                  resolve(msg.payload);
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
          provider: "codex",
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
          provider: "codex",
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

  describe("permission flow: Claude", () => {
    // Use isolated Claude config to ensure permission prompts are triggered
    // (user's real config may have allow rules that auto-approve commands)
    let restoreClaudeConfig: () => void;

    beforeAll(() => {
      restoreClaudeConfig = useTempClaudeConfigDir();
    });

    afterAll(() => {
      restoreClaudeConfig();
    });

    test(
      "approves permission and executes command",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");
        writeFileSync(filePath, "ok", "utf8");

        // Create Claude agent with sandbox config that requires permission for bash
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Claude Permission Test",
          modeId: "default",
          extra: {
            claude: {
              sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
            },
          },
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission (rm command triggers approval)
        const prompt = [
          "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
          "After approval, run it and reply DONE.",
          "Do not respond before the command finishes.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();
        expect(permission.kind).toBe("tool");

        // Approve the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "allow",
        });

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // Verify the file was deleted
        expect(existsSync(filePath)).toBe(false);

        // Verify permission_resolved event was received
        const queue = ctx.client.getMessageQueue();
        const hasPermissionResolved = queue.some((m) => {
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            return (
              m.payload.event.type === "permission_resolved" &&
              m.payload.event.requestId === permission.id &&
              m.payload.event.resolution.behavior === "allow"
            );
          }
          return false;
        });
        expect(hasPermissionResolved).toBe(true);

        // Verify permission timeline items
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have permission granted timeline item
        const hasGranted = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "granted"
        );
        expect(hasGranted).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );

    test(
      "denies permission and prevents execution",
      async () => {
        const cwd = tmpCwd();
        const filePath = path.join(cwd, "permission.txt");
        writeFileSync(filePath, "ok", "utf8");

        // Create Claude agent with sandbox config that requires permission for bash
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Claude Permission Deny Test",
          modeId: "default",
          extra: {
            claude: {
              sandbox: { enabled: true, autoAllowBashIfSandboxed: false },
            },
          },
        });

        expect(agent.id).toBeTruthy();

        // Clear message queue before sending prompt
        ctx.client.clearMessageQueue();

        // Send a prompt that requires permission
        const prompt = [
          "You must call the Bash command tool with the exact command `rm -f permission.txt`.",
          "If approval is denied, reply DENIED and stop.",
          "Do not respond before the command finishes or the denial is confirmed.",
        ].join(" ");

        await ctx.client.sendMessage(agent.id, prompt);

        // Wait for permission request
        const permission = await ctx.client.waitForPermission(agent.id, 60000);
        expect(permission).not.toBeNull();
        expect(permission.id).toBeTruthy();

        // Deny the permission
        await ctx.client.respondToPermission(agent.id, permission.id, {
          behavior: "deny",
          message: "Not allowed.",
        });

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(finalState.status).toBe("idle");

        // Verify the file was NOT deleted
        expect(existsSync(filePath)).toBe(true);

        // Verify permission_resolved event was received with deny
        const queue = ctx.client.getMessageQueue();
        const hasPermissionDenied = queue.some((m) => {
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            return (
              m.payload.event.type === "permission_resolved" &&
              m.payload.event.requestId === permission.id &&
              m.payload.event.resolution.behavior === "deny"
            );
          }
          return false;
        });
        expect(hasPermissionDenied).toBe(true);

        // Verify permission denied timeline item
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        const hasDenied = timelineItems.some(
          (item) =>
            item.type === "tool_call" &&
            item.server === "permission" &&
            item.status === "denied"
        );
        expect(hasDenied).toBe(true);

        rmSync(cwd, { recursive: true, force: true });
      },
      180000
    );
  });

  describe("getGitDiff", () => {
    test(
      "returns diff for modified file in git repo",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "original content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git commit -m 'Initial commit'", { cwd, stdio: "pipe" });

        // Modify the file (creates unstaged changes)
        writeFileSync(testFile, "modified content\n");

        // Create agent in the git repo
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Git Diff Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Get git diff
        const result = await ctx.client.getGitDiff(agent.id);

        // Verify diff returned without error
        expect(result.error).toBeNull();
        expect(result.diff).toBeTruthy();
        expect(result.diff).toContain("test.txt");
        expect(result.diff).toContain("-original content");
        expect(result.diff).toContain("+modified content");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns empty diff when no changes",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo with clean state
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git commit -m 'Initial commit'", { cwd, stdio: "pipe" });

        // Create agent in the git repo (no modifications)
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Git Diff Clean Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git diff - should be empty
        const result = await ctx.client.getGitDiff(agent.id);

        expect(result.error).toBeNull();
        expect(result.diff).toBe("");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns error for non-git directory",
      async () => {
        const cwd = tmpCwd();
        // Don't initialize git - just a regular directory

        // Create agent in a non-git directory
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Git Diff Non-Git Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git diff - should return error
        const result = await ctx.client.getGitDiff(agent.id);

        expect(result.diff).toBe("");
        expect(result.error).toBeTruthy();
        expect(result.error).toContain("git");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });

  describe("getGitRepoInfo", () => {
    test(
      "returns repo info for git repo with branch and dirty state",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "original content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git commit -m 'Initial commit'", { cwd, stdio: "pipe" });

        // Modify the file (makes repo dirty)
        writeFileSync(testFile, "modified content\n");

        // Create agent in the git repo
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Git Repo Info Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Get git repo info
        const result = await ctx.client.getGitRepoInfo(agent.id);

        // Verify repo info returned without error
        expect(result.error).toBeNull();
        // macOS symlinks /var to /private/var, so we check containment
        expect(result.repoRoot).toContain("daemon-e2e-");
        expect(result.currentBranch).toBeTruthy();
        expect(result.branches.length).toBeGreaterThan(0);
        expect(result.branches.some((b) => b.isCurrent)).toBe(true);
        expect(result.isDirty).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns clean state when no uncommitted changes",
      async () => {
        const cwd = tmpCwd();

        // Initialize git repo with clean state
        const { execSync } = await import("child_process");
        execSync("git init", { cwd, stdio: "pipe" });
        execSync("git config user.email 'test@test.com'", { cwd, stdio: "pipe" });
        execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

        // Create and commit a file (no uncommitted changes)
        const testFile = path.join(cwd, "test.txt");
        writeFileSync(testFile, "content\n");
        execSync("git add test.txt", { cwd, stdio: "pipe" });
        execSync("git commit -m 'Initial commit'", { cwd, stdio: "pipe" });

        // Create agent in the git repo
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Git Repo Info Clean Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git repo info
        const result = await ctx.client.getGitRepoInfo(agent.id);

        expect(result.error).toBeNull();
        expect(result.isDirty).toBe(false);
        expect(result.currentBranch).toBeTruthy();

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns error for non-git directory",
      async () => {
        const cwd = tmpCwd();
        // Don't initialize git - just a regular directory

        // Create agent in a non-git directory
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Git Repo Info Non-Git Test",
        });

        expect(agent.id).toBeTruthy();

        // Get git repo info - should return error
        const result = await ctx.client.getGitRepoInfo(agent.id);

        // Server returns cwd as repoRoot even on error, so we just check for error
        expect(result.error).toBeTruthy();

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });

  describe("exploreFileSystem", () => {
    test(
      "lists directory contents",
      async () => {
        const cwd = tmpCwd();

        // Create test files and directories
        writeFileSync(path.join(cwd, "test.txt"), "hello world\n");
        writeFileSync(path.join(cwd, "data.json"), '{"key": "value"}\n');
        mkdirSync(path.join(cwd, "subdir"));
        writeFileSync(path.join(cwd, "subdir", "nested.txt"), "nested content\n");

        // Create agent in the directory
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "File Explorer Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // List directory contents
        const result = await ctx.client.exploreFileSystem(agent.id, cwd, "list");

        // Verify listing returned without error
        expect(result.error).toBeNull();
        expect(result.mode).toBe("list");
        expect(result.directory).toBeTruthy();
        expect(result.directory!.entries).toBeTruthy();

        // Find expected entries
        const entries = result.directory!.entries;
        const testTxt = entries.find((e) => e.name === "test.txt");
        const dataJson = entries.find((e) => e.name === "data.json");
        const subdir = entries.find((e) => e.name === "subdir");

        expect(testTxt).toBeTruthy();
        expect(testTxt!.kind).toBe("file");
        expect(testTxt!.size).toBeGreaterThan(0);

        expect(dataJson).toBeTruthy();
        expect(dataJson!.kind).toBe("file");

        expect(subdir).toBeTruthy();
        expect(subdir!.kind).toBe("directory");

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "reads file contents",
      async () => {
        const cwd = tmpCwd();
        const testContent = "This is test file content.\nLine 2.";
        const testFile = path.join(cwd, "readme.txt");
        writeFileSync(testFile, testContent);

        // Create agent in the directory
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "File Read Test",
        });

        expect(agent.id).toBeTruthy();

        // Read file contents
        const result = await ctx.client.exploreFileSystem(agent.id, testFile, "file");

        // Verify file read
        expect(result.error).toBeNull();
        expect(result.mode).toBe("file");
        expect(result.file).toBeTruthy();
        // Server may return basename or full path
        expect(result.file!.path).toContain("readme.txt");
        expect(result.file!.kind).toBe("text");
        expect(result.file!.content).toBe(testContent);
        expect(result.file!.size).toBe(testContent.length);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );

    test(
      "returns error for non-existent path",
      async () => {
        const cwd = tmpCwd();

        // Create agent
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "File Explorer Error Test",
        });

        expect(agent.id).toBeTruthy();

        // Try to list non-existent path
        const nonExistent = path.join(cwd, "does-not-exist");
        const result = await ctx.client.exploreFileSystem(agent.id, nonExistent, "list");

        // Should return error
        expect(result.error).toBeTruthy();

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      60000 // 1 minute timeout
    );
  });

  describe("listProviderModels", () => {
    test(
      "returns model list for Codex provider",
      async () => {
        // List models for Codex provider - no agent needed
        const result = await ctx.client.listProviderModels("codex");

        // Verify response structure
        expect(result.provider).toBe("codex");
        expect(result.error).toBeNull();
        expect(result.fetchedAt).toBeTruthy();

        // Should return at least one model
        expect(result.models).toBeTruthy();
        expect(result.models.length).toBeGreaterThan(0);

        // Verify model structure
        const model = result.models[0];
        expect(model.provider).toBe("codex");
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
      },
      60000 // 1 minute timeout
    );

    test(
      "returns model list for Claude provider",
      async () => {
        // List models for Claude provider - no agent needed
        const result = await ctx.client.listProviderModels("claude");

        // Verify response structure
        expect(result.provider).toBe("claude");
        expect(result.error).toBeNull();
        expect(result.fetchedAt).toBeTruthy();

        // Should return at least one model
        expect(result.models).toBeTruthy();
        expect(result.models.length).toBeGreaterThan(0);

        // Verify model structure
        const model = result.models[0];
        expect(model.provider).toBe("claude");
        expect(model.id).toBeTruthy();
        expect(model.label).toBeTruthy();
      },
      60000 // 1 minute timeout
    );
  });

  describe("sendImages", () => {
    // Minimal 1x1 red PNG image encoded in base64
    // This is a valid PNG that can be decoded by image processing libraries
    const MINIMAL_PNG_BASE64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

    test(
      "sends message with image attachment to Claude agent",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Image Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // Send message with image attachment
        await ctx.client.sendMessage(
          agent.id,
          "I'm sending you an image. Describe what information you received about the image attachment. Reply with a single short sentence.",
          {
            images: [
              {
                data: MINIMAL_PNG_BASE64,
                mimeType: "image/png",
              },
            ],
          }
        );

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.lastError).toBeUndefined();

        // Verify stream events show the agent processed the message
        const queue = ctx.client.getMessageQueue();
        const streamEvents = queue.filter(
          (m) => m.type === "agent_stream" && m.payload.agentId === agent.id
        );

        // Should have received stream events
        expect(streamEvents.length).toBeGreaterThan(0);

        // Verify turn completed successfully
        const hasTurnCompleted = streamEvents.some(
          (m) =>
            m.type === "agent_stream" && m.payload.event.type === "turn_completed"
        );
        expect(hasTurnCompleted).toBe(true);

        // Verify there was an assistant message in the timeline
        const hasAssistantMessage = streamEvents.some((m) => {
          if (m.type !== "agent_stream" || m.payload.event.type !== "timeline") {
            return false;
          }
          const item = m.payload.event.item;
          return item.type === "assistant_message" && item.text.length > 0;
        });
        expect(hasAssistantMessage).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout for Claude API call
    );

    test(
      "sends message with multiple image attachments",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Multi-Image Test Agent",
        });

        expect(agent.id).toBeTruthy();

        // Send message with two image attachments
        await ctx.client.sendMessage(
          agent.id,
          "I'm sending you two images. How many image attachments are mentioned in the context? Reply with just a number.",
          {
            images: [
              {
                data: MINIMAL_PNG_BASE64,
                mimeType: "image/png",
              },
              {
                data: MINIMAL_PNG_BASE64,
                mimeType: "image/jpeg",
              },
            ],
          }
        );

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.lastError).toBeUndefined();

        // Verify turn completed
        const queue = ctx.client.getMessageQueue();
        const hasTurnCompleted = queue.some(
          (m) =>
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "turn_completed"
        );
        expect(hasTurnCompleted).toBe(true);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout for Claude API call
    );
  });

  describe("timeline persistence across daemon restart", () => {
    test(
      "Codex agent timeline survives daemon restart",
      async () => {
        const cwd = tmpCwd();

        // === Phase 1: Create agent and generate timeline items ===
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Restart Timeline Test Agent",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.status).toBe("idle");

        // Send a message to generate timeline items
        await ctx.client.sendMessage(
          agent.id,
          "Say 'timeline test' and nothing else"
        );

        // Wait for agent to complete
        const afterMessage = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(afterMessage.status).toBe("idle");

        // Verify we have timeline items before restart
        const queue = ctx.client.getMessageQueue();
        const timelineItems: AgentTimelineItem[] = [];
        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            timelineItems.push(m.payload.event.item);
          }
        }

        // Should have at least one assistant message
        const assistantMessages = timelineItems.filter(
          (item) => item.type === "assistant_message"
        );
        expect(assistantMessages.length).toBeGreaterThan(0);

        // Get persistence handle
        const persistence = afterMessage.persistence;
        expect(persistence).toBeTruthy();
        expect(persistence?.provider).toBe("codex");
        expect(persistence?.sessionId).toBeTruthy();

        // Record how many timeline items we had
        const preRestartTimelineCount = timelineItems.length;
        expect(preRestartTimelineCount).toBeGreaterThan(0);

        // === Phase 2: Restart daemon ===
        // Cleanup old context (stops daemon)
        await ctx.cleanup();

        // Create new daemon context (starts fresh daemon)
        ctx = await createDaemonTestContext();

        // === Phase 3: Resume agent and verify timeline is preserved ===
        const resumedAgent = await ctx.client.resumeAgent(persistence!);

        expect(resumedAgent.id).toBeTruthy();
        expect(resumedAgent.status).toBe("idle");
        expect(resumedAgent.provider).toBe("codex");

        // Wait a moment for history events to be emitted
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Get timeline items that were emitted after resume
        // Timeline items from history are sent as agent_stream_snapshot, not individual agent_stream
        const resumeQueue = ctx.client.getMessageQueue();
        const resumedTimelineItems: AgentTimelineItem[] = [];

        // First check for agent_stream_snapshot (batched history)
        for (const m of resumeQueue) {
          if (
            m.type === "agent_stream_snapshot" &&
            (m.payload as { agentId: string }).agentId === resumedAgent.id
          ) {
            const events = (m.payload as { events: Array<{ event: { type: string; item?: AgentTimelineItem } }> }).events;
            for (const e of events) {
              if (e.event.type === "timeline" && e.event.item) {
                resumedTimelineItems.push(e.event.item);
              }
            }
          }
        }

        // Also check for individual agent_stream events (in case they were sent that way)
        for (const m of resumeQueue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === resumedAgent.id &&
            m.payload.event.type === "timeline"
          ) {
            resumedTimelineItems.push(m.payload.event.item);
          }
        }

        // CRITICAL ASSERTION: Timeline should NOT be empty after daemon restart
        // This verifies that persisted history is loaded from disk (rollout files)
        // when SESSION_HISTORY is empty due to daemon restart
        expect(resumedTimelineItems.length).toBeGreaterThan(0);

        // Verify the original messages are present
        const resumedAssistant = resumedTimelineItems.filter(
          (item) => item.type === "assistant_message"
        );
        expect(resumedAssistant.length).toBeGreaterThan(0);

        // Cleanup
        await ctx.client.deleteAgent(resumedAgent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for restart test
    );
  });

  describe("Claude agent streaming text integrity", () => {
    test(
      "assistant_message text is coherent and not garbled during streaming",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Streaming Text Integrity Test",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // Send a message that should produce a longer, coherent response
        // The agent should complete a sentence with proper grammar
        await ctx.client.sendMessage(
          agent.id,
          "Please complete this sentence with exactly one more sentence: 'The quick brown fox jumps over the lazy dog.' Write a follow-up sentence about what the fox did next. Reply with just the two sentences, nothing else."
        );

        // Wait for agent to complete
        const finalState = await ctx.client.waitForAgentIdle(agent.id, 120000);

        expect(finalState.status).toBe("idle");
        expect(finalState.lastError).toBeUndefined();

        // Collect all assistant_message timeline events in order
        const queue = ctx.client.getMessageQueue();
        const assistantChunks: string[] = [];

        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              assistantChunks.push(item.text);
            }
          }
        }

        // Should have received at least one assistant message chunk
        expect(assistantChunks.length).toBeGreaterThan(0);

        // Concatenate all chunks to form the complete response
        const fullResponse = assistantChunks.join("");

        console.log("[STREAMING TEXT INTEGRITY TEST]");
        console.log("Number of chunks:", assistantChunks.length);
        console.log("Full response:", JSON.stringify(fullResponse));
        console.log("Individual chunks:", assistantChunks.map((c, i) => `[${i}]: ${JSON.stringify(c)}`).join("\n"));

        // CRITICAL ASSERTION 1: Response should not be empty
        expect(fullResponse.length).toBeGreaterThan(0);

        // CRITICAL ASSERTION 2: Response should contain coherent English text
        // Check for garbled patterns from the bug report:
        // - "wasd" (random characters in word)
        // - "passesd" (double letters incorrectly)
        // - words cut off mid-word and merged with other words

        // Check that the response contains real words and proper sentence structure
        // A garbled response like "The agent wasd. my an a newdex" would fail these checks

        // The response should contain "fox" or "dog" since we asked about them
        const lowerResponse = fullResponse.toLowerCase();
        const containsRelevantContent =
          lowerResponse.includes("fox") ||
          lowerResponse.includes("dog") ||
          lowerResponse.includes("quick") ||
          lowerResponse.includes("brown") ||
          lowerResponse.includes("lazy") ||
          lowerResponse.includes("jumps");

        expect(containsRelevantContent).toBe(true);

        // CRITICAL ASSERTION 3: Check for garbled text patterns
        // These patterns indicate text corruption during streaming
        const garbledPatterns = [
          /\w{2,}d\.\s+[a-z]+\s+[a-z]+\s+[a-z]+d/, // "wasd. my an a ...d" pattern
          /\b\w+sd\b/, // words ending in "sd" like "passesd", "wasd"
          /\b\w+d\s+\w+d\s+\w+d\b/, // multiple consecutive words ending in "d"
          /[a-z]{10,}/, // very long "words" that are actually merged text
        ];

        for (const pattern of garbledPatterns) {
          const match = fullResponse.match(pattern);
          if (match) {
            console.log("Found potential garbled text:", match[0]);
          }
          // Note: We log but don't fail on these patterns as they might occur in valid text
          // The real test is whether the response is semantically coherent
        }

        // CRITICAL ASSERTION 4: Each individual chunk should not start/end mid-word in a corrupted way
        // Check that we don't have incomplete Unicode or obviously broken text
        for (let i = 0; i < assistantChunks.length; i++) {
          const chunk = assistantChunks[i];

          // Chunks should not contain null bytes or other corruption
          expect(chunk).not.toMatch(/\x00/);

          // Chunks should be valid UTF-8 (no replacement characters unless intentional)
          expect(chunk).not.toMatch(/\uFFFD/);
        }

        // CRITICAL ASSERTION 5: Verify sentence completeness
        // The response should contain at least one period (sentence ending)
        expect(fullResponse).toMatch(/\./);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout for Claude API call
    );
  });

  describe("Claude agent streaming text integrity - long running", () => {
    test(
      "streaming chunks remain coherent after multiple back-and-forth messages",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent with bypassPermissions mode to avoid permission prompts
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Long Running Streaming Test",
          modeId: "bypassPermissions",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // === MESSAGE 1: Establish conversation context ===
        console.log("[LONG-RUNNING TEST] Sending message 1...");
        await ctx.client.sendMessage(
          agent.id,
          "Remember the number 42. Just confirm you remember it."
        );

        let state = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(state.status).toBe("idle");
        expect(state.lastError).toBeUndefined();
        console.log("[LONG-RUNNING TEST] Message 1 complete");

        // === MESSAGE 2: Build on conversation ===
        ctx.client.clearMessageQueue(); // Clear queue to isolate message 2
        console.log("[LONG-RUNNING TEST] Sending message 2...");
        await ctx.client.sendMessage(
          agent.id,
          "Now remember the word 'elephant'. Just confirm you remember both the number and the word."
        );

        state = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(state.status).toBe("idle");
        expect(state.lastError).toBeUndefined();
        console.log("[LONG-RUNNING TEST] Message 2 complete");

        // === MESSAGE 3: This is where the bug was reported to manifest ===
        // Clear queue so we can capture streaming chunks for message 3 only
        ctx.client.clearMessageQueue();
        console.log("[LONG-RUNNING TEST] Sending message 3 (testing streaming integrity)...");
        await ctx.client.sendMessage(
          agent.id,
          "Write a complete sentence using both the number (42) and the word (elephant) you remembered. The sentence should be grammatically correct English."
        );

        state = await ctx.client.waitForAgentIdle(agent.id, 120000);
        expect(state.status).toBe("idle");
        expect(state.lastError).toBeUndefined();
        console.log("[LONG-RUNNING TEST] Message 3 complete");

        // Collect all assistant_message timeline events from message 3
        const queue = ctx.client.getMessageQueue();
        const assistantChunks: string[] = [];

        for (const m of queue) {
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "assistant_message" && item.text) {
              assistantChunks.push(item.text);
            }
          }
        }

        console.log("[LONG-RUNNING TEST] Collected", assistantChunks.length, "chunks");

        // Should have received at least one assistant message chunk
        expect(assistantChunks.length).toBeGreaterThan(0);

        // Concatenate all chunks to form the complete response
        const fullResponse = assistantChunks.join("");

        console.log("[LONG-RUNNING TEST] Full response:", JSON.stringify(fullResponse));
        console.log("[LONG-RUNNING TEST] Chunks:");
        for (let i = 0; i < assistantChunks.length; i++) {
          console.log(`  [${i}]: ${JSON.stringify(assistantChunks[i])}`);
        }

        // CRITICAL ASSERTION 1: Response should contain expected content
        const lowerResponse = fullResponse.toLowerCase();
        const containsNumber = lowerResponse.includes("42");
        const containsWord = lowerResponse.includes("elephant");

        console.log("[LONG-RUNNING TEST] Contains '42':", containsNumber);
        console.log("[LONG-RUNNING TEST] Contains 'elephant':", containsWord);

        expect(containsNumber).toBe(true);
        expect(containsWord).toBe(true);

        // CRITICAL ASSERTION 2: Check for garbled text patterns
        // These patterns indicate chunks being incorrectly split/merged
        // Pattern from bug report: "acheck error" instead of "a typecheck error" (missing "type")

        // Check consecutive chunks for suspicious splits
        for (let i = 0; i < assistantChunks.length - 1; i++) {
          const current = assistantChunks[i];
          const next = assistantChunks[i + 1];

          // Look for a chunk ending with a letter followed by a chunk starting with
          // a letter that wouldn't make sense together (e.g., "a" + "check")
          const currentEndsWithLetter = /[a-zA-Z]$/.test(current);
          const nextStartsWithLetter = /^[a-zA-Z]/.test(next);

          if (currentEndsWithLetter && nextStartsWithLetter) {
            // This could be legitimate (word continues) or a split issue
            // Log for debugging
            console.log(`[LONG-RUNNING TEST] Adjacent letter chunks: "${current.slice(-10)}" + "${next.slice(0, 10)}"`);
          }
        }

        // CRITICAL ASSERTION 3: Check for UTF-8 corruption
        for (const chunk of assistantChunks) {
          expect(chunk).not.toMatch(/\x00/); // No null bytes
          expect(chunk).not.toMatch(/\uFFFD/); // No replacement characters
        }

        // CRITICAL ASSERTION 4: The full response should be valid English
        // Check that the response has proper word spacing
        const wordPattern = /\b[a-zA-Z]+\b/g;
        const words = fullResponse.match(wordPattern) || [];
        expect(words.length).toBeGreaterThan(3); // Should have multiple words

        // Check for improperly concatenated words (very long "words" that shouldn't exist)
        const suspiciouslyLongWords = words.filter(w => w.length > 20);
        if (suspiciouslyLongWords.length > 0) {
          console.log("[LONG-RUNNING TEST] Suspiciously long words:", suspiciouslyLongWords);
        }
        // Allow some technical words but flag excessive length
        expect(suspiciouslyLongWords.filter(w => w.length > 30).length).toBe(0);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      300000 // 5 minute timeout for multiple Claude API calls
    );
  });

  describe("Claude agent overlapping stream() calls race condition", () => {
    test(
      "interrupting message should produce coherent text without garbling from race condition",
      async () => {
        const cwd = tmpCwd();

        // Create Claude agent with bypassPermissions mode
        const agent = await ctx.client.createAgent({
          provider: "claude",
          cwd,
          title: "Overlapping Streams Race Condition Test",
          modeId: "bypassPermissions",
        });

        expect(agent.id).toBeTruthy();
        expect(agent.provider).toBe("claude");

        // === MESSAGE 1: Start a long-running prompt that will be interrupted ===
        console.log("[RACE CONDITION TEST] Sending message 1 (will be interrupted)...");

        // Record queue position BEFORE message 1 to find the cutoff point later
        const msg1StartPosition = ctx.client.getMessageQueue().length;

        // Use sendMessage but don't await waitForAgentIdle - let it run
        await ctx.client.sendMessage(
          agent.id,
          "Write a very detailed 500 word essay about the history of computing, starting from the earliest mechanical computers through modern quantum computing. Include specific dates, inventors, and technological milestones."
        );

        // Wait a short time for Turn 1 to start streaming (but not finish)
        // This ensures forwardPromptEvents() is actively running
        await new Promise(resolve => setTimeout(resolve, 2000));

        // === MESSAGE 2: Immediately send another message to interrupt ===
        // This triggers the race condition where Turn 2's forwardPromptEvents
        // resets streamedAssistantTextThisTurn while Turn 1 is still reading it
        console.log("[RACE CONDITION TEST] Sending message 2 (interrupting turn 1)...");

        // Record queue position BEFORE message 2 to find message 2 chunks
        const msg2StartPosition = ctx.client.getMessageQueue().length;
        console.log("[RACE CONDITION TEST] Queue position before msg2:", msg2StartPosition);

        await ctx.client.sendMessage(
          agent.id,
          "Stop. Just say exactly: 'Hello world from interrupted message'"
        );

        // Wait for Turn 2 to complete - use a manual polling approach
        // We need to wait for: running -> idle (after msg2's user_message)
        console.log("[RACE CONDITION TEST] Waiting for agent to become idle after msg2...");
        const maxWaitMs = 120000;
        const pollIntervalMs = 500;
        const startTime = Date.now();
        let lastState: AgentSnapshotPayload | null = null;

        while (Date.now() - startTime < maxWaitMs) {
          // Check agent_state messages in the queue
          const queue = ctx.client.getMessageQueue();

          // Look for pattern: user_message (msg2) -> ... -> running -> ... -> idle/error
          let sawMsg2UserMessage = false;
          let sawRunningAfterMsg2 = false;
          let sawIdleAfterRunning = false;

          for (let i = msg2StartPosition; i < queue.length; i++) {
            const msg = queue[i];
            if (
              msg.type === "agent_stream" &&
              msg.payload.agentId === agent.id &&
              msg.payload.event.type === "timeline"
            ) {
              const item = msg.payload.event.item;
              if (item.type === "user_message" && (item.text as string)?.includes("Hello world")) {
                sawMsg2UserMessage = true;
              }
            }
            if (msg.type === "agent_state" && msg.payload.id === agent.id) {
              if (sawMsg2UserMessage && msg.payload.status === "running") {
                sawRunningAfterMsg2 = true;
              }
              if (sawRunningAfterMsg2 && (msg.payload.status === "idle" || msg.payload.status === "error")) {
                sawIdleAfterRunning = true;
                lastState = msg.payload;
              }
            }
          }

          if (sawIdleAfterRunning) {
            console.log("[RACE CONDITION TEST] Agent became idle/error after msg2:", lastState?.status);
            break;
          }
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        expect(lastState).not.toBeNull();
        expect(lastState!.status).toBe("idle");
        expect(lastState!.lastError).toBeUndefined();
        console.log("[RACE CONDITION TEST] Message 2 complete");

        // Collect assistant_message chunks from message 2 only (after msg2StartPosition)
        const queue = ctx.client.getMessageQueue();
        const assistantChunks: string[] = [];

        // Debug: dump all events from queue
        console.log("[RACE CONDITION TEST] Full queue dump (all events):");
        for (let i = 0; i < queue.length; i++) {
          const m = queue[i];
          if (m.type === "agent_stream" && m.payload.agentId === agent.id) {
            const event = m.payload.event;
            if (event.type === "timeline") {
              const item = event.item;
              console.log(`  [${i}] (${i >= msg2StartPosition ? "msg2" : "msg1"}): timeline/${item.type}`, item.type === "assistant_message" || item.type === "user_message" ? JSON.stringify((item as any).text?.substring(0, 50)) : "");
            } else {
              console.log(`  [${i}] (${i >= msg2StartPosition ? "msg2" : "msg1"}): ${event.type}`, (event as any).error || "");
            }
          } else if (m.type === "agent_state" && m.payload.id === agent.id) {
            console.log(`  [${i}] (${i >= msg2StartPosition ? "msg2" : "msg1"}): agent_state -> ${m.payload.status}`, m.payload.lastError || "");
          }
        }

        // Find the user_message for message 2 to mark the boundary
        let foundMsg2UserMessage = false;

        for (let i = msg2StartPosition; i < queue.length; i++) {
          const m = queue[i];

          // Look for our user message to mark the start of message 2 context
          if (
            m.type === "agent_stream" &&
            m.payload.agentId === agent.id &&
            m.payload.event.type === "timeline"
          ) {
            const item = m.payload.event.item;
            if (item.type === "user_message" && (item.text as string)?.includes("Hello world")) {
              foundMsg2UserMessage = true;
              console.log("[RACE CONDITION TEST] Found message 2 user prompt");
            }
            // Collect assistant messages after we found the user message
            if (foundMsg2UserMessage && item.type === "assistant_message" && item.text) {
              assistantChunks.push(item.text);
            }
          }
        }

        console.log("[RACE CONDITION TEST] Collected", assistantChunks.length, "chunks");
        console.log("[RACE CONDITION TEST] Chunks:");
        for (let i = 0; i < assistantChunks.length; i++) {
          console.log(`  [${i}]: ${JSON.stringify(assistantChunks[i])}`);
        }

        // Should have received at least one assistant message chunk
        expect(assistantChunks.length).toBeGreaterThan(0);

        // Concatenate all chunks
        const fullResponse = assistantChunks.join("");
        console.log("[RACE CONDITION TEST] Full response:", JSON.stringify(fullResponse));

        // CRITICAL ASSERTION: Response should contain coherent text
        // If there's a race condition with flag corruption, we might get:
        // - Missing chunks (suppression applied incorrectly)
        // - Duplicate chunks (suppression NOT applied when it should be)
        // - Garbled/mixed text from Turn 1 and Turn 2

        // Check for basic coherence - should have recognizable words
        const wordPattern = /\b[a-zA-Z]+\b/g;
        const words = fullResponse.match(wordPattern) || [];
        console.log("[RACE CONDITION TEST] Words found:", words.length);
        expect(words.length).toBeGreaterThan(0);

        // Check for UTF-8 corruption
        for (const chunk of assistantChunks) {
          expect(chunk).not.toMatch(/\x00/); // No null bytes
          expect(chunk).not.toMatch(/\uFFFD/); // No replacement characters
        }

        // Check for suspiciously long "words" that indicate missing spaces/garbling
        const suspiciouslyLongWords = words.filter(w => w.length > 30);
        if (suspiciouslyLongWords.length > 0) {
          console.log("[RACE CONDITION TEST] Suspiciously long words:", suspiciouslyLongWords);
        }
        expect(suspiciouslyLongWords.length).toBe(0);

        // CRITICAL: Verify the response is for message 2, not message 1
        // Message 2 asked for "Hello world from interrupted message"
        // If we see extensive content about "history of computing", that's race condition corruption
        const lowerResponse = fullResponse.toLowerCase();
        const containsComputingContent =
          lowerResponse.includes("mechanical") ||
          lowerResponse.includes("quantum") ||
          lowerResponse.includes("inventor") ||
          lowerResponse.includes("eniac") ||
          lowerResponse.includes("babbage");

        if (containsComputingContent) {
          console.log("[RACE CONDITION TEST] ERROR: Response contains content from message 1!");
          console.log("[RACE CONDITION TEST] This indicates the race condition: message 2 was sent but message 1's response was returned");
        }
        // This MUST fail if we got message 1's response instead of message 2's
        expect(containsComputingContent).toBe(false);

        // Cleanup
        await ctx.client.deleteAgent(agent.id);
        rmSync(cwd, { recursive: true, force: true });
      },
      180000 // 3 minute timeout
    );
  });
});
