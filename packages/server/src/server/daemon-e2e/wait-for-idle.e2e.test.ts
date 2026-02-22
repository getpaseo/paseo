import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/index.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "wait-for-idle-e2e-"));
}

/**
 * Tests for waitForFinish edge cases.
 * Uses haiku for speed. Allow higher timeouts in CI / congested environments.
 */
describe("waitForFinish edge cases", () => {
  let ctx: DaemonTestContext;
  let collector: MessageCollector;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    collector = createMessageCollector(ctx.client);
  });

  afterEach(async () => {
    collector.unsubscribe();
    await ctx.cleanup();
  }, 30000);

  test("waitForFinish immediately after sendMessage", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd,
      title: "Immediate Wait Test",
      modeId: "bypassPermissions",
    });

    // This was the original bug: waitForFinish returned old idle states
    collector.clear();
    await ctx.client.sendMessage(agent.id, "Say 'hello'");
    const state = await ctx.client.waitForFinish(agent.id, 30000);

    expect(state.status).toBe("idle");

    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 45000);

  test("rapid fire messages then single wait", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "claude",
      model: "haiku",
      cwd,
      title: "Rapid Fire Test",
      modeId: "bypassPermissions",
    });

    // Send 3 messages without waiting - tests that waitForFinish
    // finds the idle AFTER the last running state
    collector.clear();
    await ctx.client.sendMessage(agent.id, "Say 'one'");
    await ctx.client.sendMessage(agent.id, "Say 'two'");
    await ctx.client.sendMessage(agent.id, "Say 'three'");

    const state = await ctx.client.waitForFinish(agent.id, 30000);
    expect(state.status).toBe("idle");

    // Verify all 3 messages were recorded
    const userMessages = collector.messages.filter(
      (m) =>
        m.type === "agent_stream" &&
        m.payload.agentId === agent.id &&
        m.payload.event.type === "timeline" &&
        m.payload.event.item.type === "user_message"
    );
    expect(userMessages.length).toBe(3);

    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }, 45000);

  test("two agents: waitForFinish filters by agent", async () => {
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
    collector.clear();
    await ctx.client.sendMessage(agent1.id, "Say 'agent one'");
    await ctx.client.sendMessage(agent2.id, "Say 'agent two'");

    // Wait for each - should not be confused by the other's state
    const state2 = await ctx.client.waitForFinish(agent2.id, 30000);
    expect(state2.status).toBe("idle");
    expect(state2.final?.id).toBe(agent2.id);

    const state1 = await ctx.client.waitForFinish(agent1.id, 30000);
    expect(state1.status).toBe("idle");
    expect(state1.final?.id).toBe(agent1.id);

    await ctx.client.deleteAgent(agent1.id);
    await ctx.client.deleteAgent(agent2.id);
    rmSync(cwd1, { recursive: true, force: true });
    rmSync(cwd2, { recursive: true, force: true });
  }, 60000);

  test("waitForFinish resolves first idle edge even if a new run starts immediately after", async () => {
    const cwd = tmpCwd();

    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Idle Edge Coherence",
      modeId: "bypassPermissions",
    });

    let sawRunning = false;
    let spawnedSecondRun = false;
    let secondRunDrain: Promise<void> | null = null;
    const unsubscribe = ctx.daemon.daemon.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_state" || event.agent.id !== agent.id) {
          return;
        }
        if (event.agent.lifecycle === "running") {
          sawRunning = true;
          return;
        }
        if (
          event.agent.lifecycle !== "idle" ||
          !sawRunning ||
          spawnedSecondRun
        ) {
          return;
        }

        spawnedSecondRun = true;
        const stream = ctx.daemon.daemon.agentManager.streamAgent(
          agent.id,
          "Use your shell tool to run sleep 1 and then reply done."
        );
        secondRunDrain = (async () => {
          for await (const _event of stream) {
            // Drain second run so manager can settle.
          }
        })();
      },
      { agentId: agent.id, replayState: false }
    );

    try {
      await ctx.client.sendMessage(agent.id, "Reply with exactly: first");
      const state = await ctx.client.waitForFinish(agent.id, 30000);

      expect(spawnedSecondRun).toBe(true);
      expect(state.status).toBe("idle");
      expect(state.final?.status === "idle" || state.final?.status === "running").toBe(true);
      expect(state.error).toBeNull();
    } finally {
      unsubscribe();
      await secondRunDrain;
      await ctx.client.deleteAgent(agent.id);
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 60000);
});
