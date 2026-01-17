import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "wait-for-idle-e2e-"));
}

/**
 * Tests for waitForAgentIdle edge cases.
 * Uses haiku for speed. 10s timeout per operation - if slower, it's a bug.
 */
describe("waitForAgentIdle edge cases", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 15000);

  test("waitForAgentIdle immediately after sendMessage", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd,
      title: "Immediate Wait Test",
      modeId: "bypassPermissions",
    });

    // This was the original bug: waitForAgentIdle returned old idle states
    await ctx.client.sendMessage(agent.id, "Say 'hello'");
    const state = await ctx.client.waitForAgentIdle(agent.id, 10000);

    expect(state.status).toBe("idle");

    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 15000);

  test("rapid fire messages then single wait", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd,
      title: "Rapid Fire Test",
      modeId: "bypassPermissions",
    });

    // Send 3 messages without waiting - tests that waitForAgentIdle
    // finds the idle AFTER the last running state
    await ctx.client.sendMessage(agent.id, "Say 'one'");
    await ctx.client.sendMessage(agent.id, "Say 'two'");
    await ctx.client.sendMessage(agent.id, "Say 'three'");

    const state = await ctx.client.waitForAgentIdle(agent.id, 10000);
    expect(state.status).toBe("idle");

    // Verify all 3 messages were recorded
    const queue = ctx.client.getMessageQueue();
    const userMessages = queue.filter(
      (m) =>
        m.type === "agent_stream" &&
        m.payload.agentId === agent.id &&
        m.payload.event.type === "timeline" &&
        m.payload.event.item.type === "user_message"
    );
    expect(userMessages.length).toBe(3);

    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 15000);

  test("two agents: waitForAgentIdle filters by agent", async () => {
    const cwd1 = tmpCwd();
    const cwd2 = tmpCwd();

    const agent1 = await ctx.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: cwd1,
      title: "Agent 1",
      modeId: "bypassPermissions",
    });

    const agent2 = await ctx.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd: cwd2,
      title: "Agent 2",
      modeId: "bypassPermissions",
    });

    // Start both agents
    await ctx.client.sendMessage(agent1.id, "Say 'agent one'");
    await ctx.client.sendMessage(agent2.id, "Say 'agent two'");

    // Wait for each - should not be confused by the other's state
    const state2 = await ctx.client.waitForAgentIdle(agent2.id, 10000);
    expect(state2.status).toBe("idle");
    expect(state2.id).toBe(agent2.id);

    const state1 = await ctx.client.waitForAgentIdle(agent1.id, 10000);
    expect(state1.status).toBe("idle");
    expect(state1.id).toBe(agent1.id);

    await ctx.client.deleteAgent(agent1.id);
    await ctx.client.deleteAgent(agent2.id);
    rmSync(cwd1, { recursive: true, force: true });
    rmSync(cwd2, { recursive: true, force: true });
  }, 25000);
});
