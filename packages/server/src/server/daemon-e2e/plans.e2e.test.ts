import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";
import { CodexAppServerAgentClient } from "../agent/providers/codex-app-server-agent.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { isProviderAvailable } from "./agent-configs.js";
import type { PlanTimelineItem } from "../agent/agent-sdk-types.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-plans-"));
}

function waitForPlanMessage(
  collector: MessageCollector,
  agentId: string,
  timeoutMs: number,
): Promise<PlanTimelineItem> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const message = collector.messages.find((candidate) => {
        if (candidate.type !== "agent_stream") return false;
        if (candidate.payload.agentId !== agentId) return false;
        return (
          candidate.payload.event.type === "timeline" &&
          candidate.payload.event.item.type === "plan"
        );
      });
      if (message?.type === "agent_stream") {
        const event = message.payload.event;
        if (event.type === "timeline" && event.item.type === "plan") {
          clearInterval(timer);
          resolve(event.item);
        }
      }
      if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for plan item after ${timeoutMs}ms`));
      }
    }, 100);
  });
}

describe("daemon E2E - first-class plans", () => {
  let ctx: DaemonTestContext;
  let collector: MessageCollector;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
    collector = createMessageCollector(ctx.client);
  });

  afterEach(async () => {
    collector.unsubscribe();
    await ctx.cleanup();
  }, 60_000);

  test("surfaces an actionable plan and routes the response through the daemon", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Plan E2E",
        modeId: "full-access",
      });

      collector.clear();
      await ctx.client.sendMessage(agent.id, "Emit an actionable plan.");
      const finalState = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(finalState.status).toBe("idle");

      const planMessage = collector.messages.find((message) => {
        if (message.type !== "agent_stream") return false;
        if (message.payload.agentId !== agent.id) return false;
        return (
          message.payload.event.type === "timeline" && message.payload.event.item.type === "plan"
        );
      });
      expect(planMessage?.type).toBe("agent_stream");
      if (planMessage?.type !== "agent_stream") {
        throw new Error("Expected plan stream message");
      }
      const event = planMessage.payload.event;
      if (event.type !== "timeline" || event.item.type !== "plan") {
        throw new Error("Expected normalized plan item");
      }
      expect(event.item.actions).toEqual([
        { id: "implement", label: "Implement", variant: "primary" },
      ]);

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      expect(
        timeline.entries.some(
          (entry) => entry.item.type === "plan" && entry.item.planId === event.item.planId,
        ),
      ).toBe(true);

      const response = await ctx.client.respondToPlan(agent.id, event.item.planId, {
        actionId: "implement",
      });
      expect(response).toMatchObject({
        agentId: agent.id,
        planId: event.item.planId,
        ok: true,
        error: null,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("surfaces a plan file as a non-actionable plan", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "opencode",
        cwd,
        title: "Plan File E2E",
        modeId: "full-access",
      });

      collector.clear();
      await ctx.client.sendMessage(agent.id, "Emit a plan file.");
      await ctx.client.waitForFinish(agent.id, 5_000);

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const plan = timeline.entries.find(
        (entry) =>
          entry.item.type === "plan" && entry.item.planId === "plan-file:.paseo/plans/fake.md",
      );

      expect(plan?.item).toEqual({
        type: "plan",
        planId: "plan-file:.paseo/plans/fake.md",
        text: "# File plan\n\n- From disk",
      });
      const response = await ctx.client.respondToPlan(agent.id, "plan-file:.paseo/plans/fake.md", {
        actionId: "implement",
      });
      expect(response.ok).toBe(false);
      expect(response.error).toContain("No pending fake plan");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("daemon E2E - first-class plans with real providers", () => {
  test("real Codex plan mode surfaces a normalized actionable plan", async (context) => {
    if (!(await isProviderAvailable("codex"))) {
      context.skip();
    }

    const cwd = tmpCwd();
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { codex: new CodexAppServerAgentClient(logger) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "real-codex-plan" } });
      const agent = await client.createAgent({
        provider: "codex",
        cwd,
        title: "Real Codex Plan E2E",
        modeId: "auto",
        model: "gpt-5.4",
        thinkingOptionId: "medium",
        featureValues: { plan_mode: true },
      });

      await client.sendMessage(
        agent.id,
        "You are in plan mode. Produce a markdown plan with a short heading and exactly 3 bullets for implementing a login screen. Do not ask questions.",
      );
      await client.waitForFinish(agent.id, 240_000);

      const timeline = await client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      });
      const plan = timeline.entries.find((entry) => entry.item.type === "plan");

      expect(plan?.item.type).toBe("plan");
      if (!plan || plan.item.type !== "plan") {
        throw new Error("Expected normalized plan item");
      }
      expect(plan.item.text).toContain("Login");
      expect(plan.item.actions?.some((action) => action.id === "implement")).toBe(true);
    } finally {
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  test("real Claude plan mode surfaces a normalized actionable plan", async (context) => {
    if (!(await isProviderAvailable("claude"))) {
      context.skip();
    }

    const cwd = tmpCwd();
    const logger = pino({ level: "silent" });
    const daemon = await createTestPaseoDaemon({
      agentClients: { claude: new ClaudeAgentClient({ logger }) },
      logger,
    });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    const collector = createMessageCollector(client);

    try {
      await client.connect();
      await client.fetchAgents({ subscribe: { subscriptionId: "real-claude-plan" } });
      const agent = await client.createAgent({
        provider: "claude",
        cwd,
        title: "Real Claude Plan E2E",
        modeId: "plan",
        model: "haiku",
      });

      collector.clear();
      await client.sendMessage(
        agent.id,
        [
          "Create a short implementation plan for a login screen.",
          "Use plan mode and call ExitPlanMode with a markdown plan.",
          "Do not edit files.",
        ].join(" "),
      );

      const plan = await waitForPlanMessage(collector, agent.id, 120_000);
      expect(plan.text).toContain("login");
      expect(plan.actions?.some((action) => action.id === "implement")).toBe(true);

      const snapshot = await client.fetchAgent(agent.id);
      expect(snapshot.agent?.pendingPermissions ?? []).toEqual([]);

      const response = await client.respondToPlan(agent.id, plan.planId, { actionId: "reject" });
      expect(response).toMatchObject({
        agentId: agent.id,
        planId: plan.planId,
        ok: true,
        error: null,
      });
    } finally {
      collector.unsubscribe();
      await client.close().catch(() => undefined);
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
