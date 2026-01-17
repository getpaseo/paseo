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

  describe("multi-agent orchestration", () => {
    test(
      "parent agent creates child agent via agent-control MCP",
      async () => {
        const cwd = tmpCwd();
        const childCwd = tmpCwd();

        // Create parent Codex agent
        const parent = await ctx.client.createAgent({
          provider: "codex", model: CODEX_TEST_MODEL, reasoningEffort: CODEX_TEST_REASONING_EFFORT,
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
            item.name === "agent-control.create_agent"
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
            item.name === "agent-control.create_agent"
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


});
