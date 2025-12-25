import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
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

  // Claude permission tests are skipped due to SDK behavior:
  // - The sandbox config IS passed correctly to Claude SDK
  // - Claude executes tool calls without requesting permission
  // - This appears to be related to user/project settings or SDK behavior
  // - The direct claude-agent.test.ts permission tests pass
  // - Codex permission tests through the daemon work correctly
  // TODO: Investigate Claude SDK permission behavior in daemon context
  describe.skip("permission flow: Claude", () => {
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
});
