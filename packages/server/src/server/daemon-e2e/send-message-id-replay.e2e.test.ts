import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "send-message-id-replay-"));
}

describe("send_agent_message_request replay", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("does not start a second run when the same client messageId is replayed", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "duplicate message replay",
        modeId: "full-access",
      });

      const messageId = "msg-replay-1";
      await ctx.client.sendMessage(agent.id, "Reply with exactly hello", { messageId });
      await ctx.client.waitForFinish(agent.id, 5_000);

      const afterFirst = await ctx.client.fetchAgent(agent.id);
      expect(afterFirst?.agent.status).toBe("idle");
      const firstUpdatedAt = afterFirst?.agent.updatedAt ?? null;
      expect(firstUpdatedAt).not.toBeNull();

      await ctx.client.sendMessage(agent.id, "Reply with exactly hello", { messageId });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterReplay = await ctx.client.fetchAgent(agent.id);
      expect(afterReplay?.agent.status).toBe("idle");
      expect(afterReplay?.agent.updatedAt ?? null).toBe(firstUpdatedAt);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not start a second run when identical text is replayed with a new messageId right after finish", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "duplicate text replay after finish",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(agent.id, "Reply with exactly hello", { messageId: "msg-1" });
      await ctx.client.waitForFinish(agent.id, 5_000);

      const afterFirst = await ctx.client.fetchAgent(agent.id);
      expect(afterFirst?.agent.status).toBe("idle");
      const firstUpdatedAt = afterFirst?.agent.updatedAt ?? null;
      expect(firstUpdatedAt).not.toBeNull();

      await ctx.client.sendMessage(agent.id, "Reply with exactly hello", { messageId: "msg-2" });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const afterReplay = await ctx.client.fetchAgent(agent.id);
      expect(afterReplay?.agent.status).toBe("idle");
      expect(afterReplay?.agent.updatedAt ?? null).toBe(firstUpdatedAt);

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 20,
        projection: "canonical",
      });
      const userMessages = timeline.entries.filter(
        (entry) => entry.item.type === "user_message" && entry.item.text === "Reply with exactly hello",
      );
      expect(userMessages).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not replace an active run when identical text is resent with a new messageId", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "duplicate text replay while running",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(agent.id, "Run: sleep 30", { messageId: "msg-running-1" });
      await ctx.client.waitForAgentUpsert(agent.id, (snapshot) => snapshot.status === "running", 5_000);

      await ctx.client.sendMessage(agent.id, "Run: sleep 30", { messageId: "msg-running-2" });
      const afterReplay = await ctx.client.waitForFinish(agent.id, 5_000);
      expect(afterReplay.status).toBe("idle");

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 20,
        projection: "canonical",
      });
      const userMessages = timeline.entries.filter(
        (entry) => entry.item.type === "user_message" && entry.item.text === "Run: sleep 30",
      );
      expect(userMessages).toHaveLength(1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
