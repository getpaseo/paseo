import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { SessionOutboundMessage } from "../messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

describe("daemon E2E - persistence", () => {
  let ctx: DaemonTestContext;
  let messages: SessionOutboundMessage[] = [];
  let unsubscribe: (() => void) | null = null;
  let cleaned = false;

  beforeEach(async () => {
    cleaned = false;
    ctx = await createDaemonTestContext();
    messages = [];
    unsubscribe = ctx.client.subscribeRawMessages((message) => {
      messages.push(message);
    });
  });

  afterEach(async () => {
    unsubscribe?.();
    if (!cleaned) {
      await ctx.cleanup();
    }
  }, 60_000);

  test(
    "persists and resumes Codex agent with conversation context",
    async () => {
      const cwd = tmpCwd();
      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Persistence Test Agent",
          modeId: "full-access",
        });

        messages.length = 0;
        await ctx.client.sendMessage(agent.id, "Say 'state saved' and nothing else");
        const afterMessage = await ctx.client.waitForFinish(agent.id, 5_000);
        expect(afterMessage.status).toBe("idle");
        expect(afterMessage.final?.persistence).toBeTruthy();
        expect(afterMessage.final?.persistence?.provider).toBe("codex");
        expect(afterMessage.final?.persistence?.sessionId).toBeTruthy();
        expect((afterMessage.final?.persistence?.metadata as { conversationId?: string } | undefined)?.conversationId)
          .toBeTruthy();

        const handle = afterMessage.final!.persistence!;

        await ctx.client.deleteAgent(agent.id);

        const resumed = await ctx.client.resumeAgent(handle);
        expect(resumed.provider).toBe("codex");
        expect(resumed.cwd).toBe(cwd);

        messages.length = 0;
        await ctx.client.sendMessage(resumed.id, "What did I ask you to say earlier?");
        const afterResume = await ctx.client.waitForFinish(resumed.id, 5_000);
        expect(afterResume.status).toBe("idle");

        const assistantText = extractAssistantText(messages, resumed.id);
        expect(assistantText.toLowerCase()).toContain("state saved");

        await ctx.client.deleteAgent(resumed.id);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );

  test(
    "timeline survives daemon restart",
    async () => {
      const cwd = tmpCwd();
      const junctionHomeRoot = mkdtempSync(path.join(tmpdir(), "junction-home-root-"));
      try {
        // Start daemon with a stable on-disk home so "restart" can observe persisted timeline.
        await ctx.cleanup();
        ctx = await createDaemonTestContext({ junctionHomeRoot, cleanup: false });
        unsubscribe?.();
        messages = [];
        unsubscribe = ctx.client.subscribeRawMessages((message) => {
          messages.push(message);
        });

        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Restart Timeline Test Agent",
          modeId: "full-access",
        });
        const agentId = agent.id;

        messages.length = 0;
        await ctx.client.sendMessage(agentId, "Say 'timeline test' and nothing else");
        const afterMessage = await ctx.client.waitForFinish(agentId, 5_000);
        expect(afterMessage.status).toBe("idle");
        expect(afterMessage.final?.persistence).toBeTruthy();

        await ctx.cleanup();
        ctx = await createDaemonTestContext({ junctionHomeRoot, cleanup: false });
        unsubscribe?.();
        messages = [];
        unsubscribe = ctx.client.subscribeRawMessages((message) => {
          messages.push(message);
        });

        const timeline = await ctx.client.fetchAgentTimeline(agentId, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        });
        const timelineItems = timeline.entries.map((entry) => entry.item);
        expect(timelineItems.length).toBeGreaterThan(0);
        expect(timelineItems.some((item) => item.type === "assistant_message")).toBe(true);
      } finally {
        await ctx.cleanup();
        cleaned = true;
        rmSync(cwd, { recursive: true, force: true });
        rmSync(junctionHomeRoot, { recursive: true, force: true });
      }
    },
    30_000
  );
});

function extractAssistantText(queue: SessionOutboundMessage[], agentId: string): string {
  const parts: string[] = [];
  for (const m of queue) {
    if (m.type !== "agent_stream") continue;
    if (m.payload.agentId !== agentId) continue;
    if (m.payload.event.type !== "timeline") continue;
    const item = m.payload.event.item;
    if (item.type === "assistant_message") {
      parts.push(item.text);
    }
  }
  return parts.join("");
}
