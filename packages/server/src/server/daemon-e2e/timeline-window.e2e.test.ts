import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

describe("daemon E2E - timeline window", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test(
    "canonical tail limit keeps assistant chunks intact at the window boundary",
    async () => {
      const cwd = tmpCwd();
      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Timeline Window Boundary Test",
          modeId: "full-access",
        });

        const expected = "1234567890ABCDEFGHIJ";
        await ctx.client.sendMessage(agent.id, `Respond with exactly: ${expected}`);
        const finalState = await ctx.client.waitForFinish(agent.id, 5_000);
        expect(finalState.status).toBe("idle");

        const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 1,
          projection: "canonical",
        });

        const assistantTexts = timeline.entries
          .filter((entry) => entry.item.type === "assistant_message")
          .map((entry) => entry.item.text);

        expect(assistantTexts).toHaveLength(2);
        expect(assistantTexts.join("")).toBe(expected);
        expect(timeline.startCursor?.seq).toBeLessThan(timeline.endCursor?.seq ?? 0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );

  test(
    "canonical tail limit does not widen to full history once boundary is resolved",
    async () => {
      const cwd = tmpCwd();
      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Timeline Window Scope Test",
          modeId: "full-access",
        });

        await ctx.client.sendMessage(agent.id, "Respond with exactly: FIRST-RESPONSE");
        expect((await ctx.client.waitForFinish(agent.id, 5_000)).status).toBe("idle");

        const expected = "SECOND-RESPONSE";
        await ctx.client.sendMessage(agent.id, `Respond with exactly: ${expected}`);
        expect((await ctx.client.waitForFinish(agent.id, 5_000)).status).toBe("idle");

        const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
          direction: "tail",
          limit: 1,
          projection: "canonical",
        });

        const assistantTexts = timeline.entries
          .filter((entry) => entry.item.type === "assistant_message")
          .map((entry) => entry.item.text);

        expect(assistantTexts.join("")).toBe(expected);
        expect(timeline.hasOlder).toBe(true);
        expect(timeline.startCursor?.seq).toBeGreaterThan(1);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );
});
