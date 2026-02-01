import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import { createMessageCollector, type MessageCollector } from "../test-utils/message-collector.js";
import type { PersistenceHandle } from "../../shared/messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "two-cycle-resume-"));
}

describe("two-cycle Codex agent resume", () => {
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

  test(
    "Codex agent remembers original marker after two resume cycles",
    async () => {
      const cwd = tmpCwd();
      const marker = `project-unicorn-${Date.now()}`;
      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Two Cycle Resume Test",
          modeId: "full-access",
        });

        collector.clear();
        await ctx.client.sendMessage(
          agent.id,
          `Remember this project name for a test: "${marker}".`
        );
        const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
        expect(afterRemember.status).toBe("idle");
        expect(afterRemember.final?.persistence).toBeTruthy();

        const persistence0 = afterRemember.final!.persistence as PersistenceHandle;
        await ctx.client.deleteAgent(agent.id);

        collector.clear();
        const resumed1 = await ctx.client.resumeAgent(persistence0);
        await ctx.client.sendMessage(
          resumed1.id,
          "What was the project name I asked you to remember at the very beginning of our conversation?"
        );
        const afterRecall1 = await ctx.client.waitForFinish(resumed1.id, 5_000);
        expect(afterRecall1.status).toBe("idle");
        expect(afterRecall1.final?.persistence).toBeTruthy();
        expect(afterRecall1.final!.persistence!.metadata).toMatchObject({ marker });

        const persistence1 = afterRecall1.final!.persistence as PersistenceHandle;
        await ctx.client.deleteAgent(resumed1.id);

        collector.clear();
        const resumed2 = await ctx.client.resumeAgent(persistence1);
        await ctx.client.sendMessage(
          resumed2.id,
          "What was the project name I asked you to remember at the very beginning of our conversation?"
        );
        const afterRecall2 = await ctx.client.waitForFinish(resumed2.id, 5_000);
        expect(afterRecall2.status).toBe("idle");
        expect(afterRecall2.final?.persistence).toBeTruthy();
        expect(afterRecall2.final!.persistence!.metadata).toMatchObject({ marker });

        await ctx.client.deleteAgent(resumed2.id);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );
});

