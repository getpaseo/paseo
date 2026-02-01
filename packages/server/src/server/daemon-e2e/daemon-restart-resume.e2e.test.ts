import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";
import type { PersistenceHandle } from "../../shared/messages.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-restart-resume-"));
}

describe("daemon restart resume", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test(
    "Codex agent survives daemon restart with persistence handle",
    async () => {
      const cwd = tmpCwd();
      const marker = `DAEMON_RESTART_MARKER_${Date.now()}`;
      try {
        const agent = await ctx.client.createAgent({
          provider: "codex",
          cwd,
          title: "Daemon Restart Test Agent",
          modeId: "full-access",
        });

        await ctx.client.sendMessage(
          agent.id,
          `Remember this marker string for a test: "${marker}".`
        );

        const afterRemember = await ctx.client.waitForFinish(agent.id, 5_000);
        expect(afterRemember.status).toBe("idle");
        expect(afterRemember.final?.persistence).toBeTruthy();
        expect(afterRemember.final!.persistence!.metadata).toMatchObject({ marker });

        const handle = afterRemember.final!.persistence as PersistenceHandle;

        await ctx.cleanup();
        ctx = await createDaemonTestContext();

        const resumed = await ctx.client.resumeAgent(handle);
        await ctx.client.sendMessage(
          resumed.id,
          "What was the marker string I asked you to remember earlier?"
        );

        const afterRecall = await ctx.client.waitForFinish(resumed.id, 5_000);
        expect(afterRecall.status).toBe("idle");
        expect(afterRecall.final?.persistence).toBeTruthy();
        expect(afterRecall.final!.persistence!.metadata).toMatchObject({ marker });

        await ctx.client.deleteAgent(resumed.id);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    30_000
  );
});

