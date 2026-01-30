import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { PersistenceHandle } from "../../shared/messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "two-cycle-resume-"));
}

const CODEX_TEST_MODEL = "gpt-5.1-codex-mini";
const CODEX_TEST_REASONING_EFFORT = "low";

describe("two-cycle Codex agent resume", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60000);

  test(
    "Codex agent remembers original marker after two resume cycles",
    async () => {
      const cwd = tmpCwd();
      // Use a memorable marker - a fake project name that's easy to recall
      const MARKER = `project-unicorn-${Date.now()}`;

      // === CYCLE 0: Create agent and establish marker ===
      const agent = await ctx.client.createAgent({
        provider: "codex",
        model: CODEX_TEST_MODEL,
        reasoningEffort: CODEX_TEST_REASONING_EFFORT,
        cwd,
        title: "Two Cycle Resume Test",
        modeId: "full-access",
      });

      expect(agent.id).toBeTruthy();
      expect(agent.status).toBe("idle");

      // Send the marker - phrase it as a test instruction
      await ctx.client.sendMessage(
        agent.id,
        `For this test session, remember this project name: "${MARKER}". Just confirm you've noted it.`
      );

      const afterSecret = await ctx.client.waitForFinish(agent.id, 120000);
      expect(afterSecret.status).toBe("idle");
      expect(afterSecret.lastError).toBeUndefined();

      // Verify agent confirmed
      const queue0 = ctx.client.getMessageQueue();
      const confirmations: string[] = [];
      for (const m of queue0) {
        if (
          m.type === "agent_stream" &&
          m.payload.agentId === agent.id &&
          m.payload.event.type === "timeline"
        ) {
          const item = m.payload.event.item;
          if (item.type === "assistant_message" && item.text) {
            confirmations.push(item.text);
          }
        }
      }
      expect(confirmations.join("").length).toBeGreaterThan(0);

      // Get persistence handle
      expect(afterSecret.persistence).toBeTruthy();
      const persistence0 = afterSecret.persistence as PersistenceHandle;
      expect(persistence0.provider).toBe("codex");
      expect(persistence0.sessionId).toBeTruthy();

      // === KILL: Delete agent and verify it's gone ===
      await ctx.client.deleteAgent(agent.id);

      // CRITICAL: Verify the agent is actually gone from the daemon
      const agentsAfterDelete0 = ctx.client.listAgents();
      const stillExists0 = agentsAfterDelete0.some((a) => a.id === agent.id);
      expect(stillExists0).toBe(false);

      // === CYCLE 1: First resume ===
      ctx.client.clearMessageQueue();
      const resumed1 = await ctx.client.resumeAgent(persistence0);

      expect(resumed1.id).toBeTruthy();
      expect(resumed1.status).toBe("idle");
      expect(resumed1.provider).toBe("codex");

      // Send a new message to create activity in the resumed session
      // This forces Codex to create a new session when it gets "session not found"
      await ctx.client.sendMessage(
        resumed1.id,
        "Acknowledge you still remember the project name. Just say yes or no."
      );

      const afterAck = await ctx.client.waitForFinish(resumed1.id, 120000);
      expect(afterAck.status).toBe("idle");
      expect(afterAck.lastError).toBeUndefined();

      // Get new persistence handle (session ID may have changed)
      expect(afterAck.persistence).toBeTruthy();
      const persistence1 = afterAck.persistence as PersistenceHandle;

      // === KILL: Delete agent and verify it's gone ===
      await ctx.client.deleteAgent(resumed1.id);

      const agentsAfterDelete1 = ctx.client.listAgents();
      const stillExists1 = agentsAfterDelete1.some((a) => a.id === resumed1.id);
      expect(stillExists1).toBe(false);

      // === CYCLE 2: Second resume ===
      ctx.client.clearMessageQueue();
      const resumed2 = await ctx.client.resumeAgent(persistence1);

      expect(resumed2.id).toBeTruthy();
      expect(resumed2.status).toBe("idle");
      expect(resumed2.provider).toBe("codex");

      // === CRITICAL TEST: Ask about the ORIGINAL marker ===
      // If history is properly accumulated, the agent should remember.
      // If history is lost on resume-of-resume, this will fail.
      await ctx.client.sendMessage(
        resumed2.id,
        "What was the project name I asked you to remember at the very beginning of our conversation? Reply with the exact name."
      );

      const afterRecall = await ctx.client.waitForFinish(resumed2.id, 120000);
      expect(afterRecall.status).toBe("idle");
      expect(afterRecall.lastError).toBeUndefined();

      // Collect the response
      const queue2 = ctx.client.getMessageQueue();
      const responses: string[] = [];
      for (const m of queue2) {
        if (
          m.type === "agent_stream" &&
          m.payload.agentId === resumed2.id &&
          m.payload.event.type === "timeline"
        ) {
          const item = m.payload.event.item;
          if (item.type === "assistant_message" && item.text) {
            responses.push(item.text);
          }
        }
      }
      const fullResponse = responses.join("");

      // CRITICAL ASSERTION: The agent should remember the original marker
      // This proves history is properly accumulated across multiple resume cycles
      expect(fullResponse).toContain(MARKER);

      // Cleanup
      await ctx.client.deleteAgent(resumed2.id);
      rmSync(cwd, { recursive: true, force: true });
    },
    600000 // 10 minute timeout for multiple API calls and resume cycles
  );
});
