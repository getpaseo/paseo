import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import type { AgentStreamEventPayload } from "../messages.js";

describe("OpenCode reasoning events (e2e)", () => {
  let ctx: DaemonTestContext;
  let agentCwd: string;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    agentCwd = await mkdtemp(path.join(os.tmpdir(), "opencode-reasoning-test-"));
  });

  afterEach(async () => {
    await ctx.cleanup();
    await rm(agentCwd, { recursive: true, force: true });
  }, 60_000);

  test(
    "gpt-5 nano emits reasoning events through daemon",
    async () => {
      const allEvents: Array<{
        event: AgentStreamEventPayload;
        timestamp: string;
      }> = [];

      // Subscribe to all events
      ctx.client.on((event) => {
        if (event.type === "agent_stream") {
          allEvents.push({
            event: event.event,
            timestamp: event.timestamp,
          });
        }
      });

      // Create agent with gpt-5 nano model
      const agent = await ctx.client.createAgent({
        provider: "opencode",
        cwd: agentCwd,
        model: "opencode/gpt-5-nano",
        title: "reasoning-test",
      });

      expect(agent.id).toBeTruthy();

      console.log("\n=== GPT-5 NANO E2E REASONING DEBUG ===\n");
      console.log(`Agent ID: ${agent.id}`);
      console.log(`Agent status: ${agent.status}`);

      // Send a message that should trigger reasoning
      await ctx.client.sendMessage(agent.id, "What is 2+2? Think step by step.");

      // Wait for agent to complete
      const finalState = await ctx.client.waitForAgentIdle(agent.id, 120_000);

      console.log(`\nFinal status: ${finalState.status}`);
      console.log(`Total events captured: ${allEvents.length}`);

      // Log all events
      console.log("\n=== ALL EVENTS ===\n");
      for (let i = 0; i < allEvents.length; i++) {
        const { event, timestamp } = allEvents[i];
        console.log(`[EVENT ${i + 1}] timestamp=${timestamp} type=${event.type}`);
        console.log(JSON.stringify(event, null, 2));
        console.log("---");
      }

      // Group by type
      const byType = new Map<string, number>();
      for (const { event } of allEvents) {
        byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
      }
      console.log("\n=== EVENTS BY TYPE ===");
      for (const [type, count] of byType) {
        console.log(`  ${type}: ${count}`);
      }

      // Check timeline events breakdown
      const timelineEvents = allEvents.filter(
        ({ event }) => event.type === "timeline"
      );
      const itemTypes = new Map<string, number>();
      for (const { event } of timelineEvents) {
        if (event.type === "timeline") {
          itemTypes.set(event.item.type, (itemTypes.get(event.item.type) ?? 0) + 1);
        }
      }
      console.log("\n=== TIMELINE ITEM TYPES ===");
      for (const [type, count] of itemTypes) {
        console.log(`  ${type}: ${count}`);
      }

      // Find reasoning events
      const reasoningEvents = timelineEvents.filter(
        ({ event }) => event.type === "timeline" && event.item.type === "reasoning"
      );
      console.log(`\nReasoning events: ${reasoningEvents.length}`);
      for (const { event } of reasoningEvents.slice(0, 5)) {
        if (event.type === "timeline") {
          console.log("Sample reasoning:", JSON.stringify(event.item, null, 2));
        }
      }

      // Check for duplicate consecutive events
      console.log("\n=== DUPLICATE CHECK ===");
      let duplicateCount = 0;
      for (let i = 1; i < allEvents.length; i++) {
        const prev = allEvents[i - 1];
        const curr = allEvents[i];
        if (JSON.stringify(prev.event) === JSON.stringify(curr.event)) {
          duplicateCount++;
          if (duplicateCount <= 5) {
            console.log(`Duplicate at index ${i}:`, JSON.stringify(curr.event, null, 2));
          }
        }
      }
      console.log(`Total duplicates: ${duplicateCount}`);

      console.log("\n=== END DEBUG ===\n");

      // HARD ASSERT: Agent completed
      expect(finalState.status).toBe("idle");

      // HARD ASSERT: Got events
      expect(allEvents.length).toBeGreaterThan(0);

      // Delete the agent
      await ctx.client.deleteAgent(agent.id);
    },
    180_000
  );
});
