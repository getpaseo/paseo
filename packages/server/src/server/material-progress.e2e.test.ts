import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/index.js";

describe("daemon E2E - material progress snapshot", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  }, 60_000);

  test("agent fetch reports progress, compaction stall, recovery, and archived readback", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "material-progress-e2e-"));
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Material Progress E2E",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(agent.id, "Respond with exactly: READY");
      expect((await ctx.client.waitForFinish(agent.id, 5_000)).status).toBe("idle");

      const afterAcceptedTurn = await ctx.client.fetchAgent({ agentId: agent.id });
      expect(afterAcceptedTurn?.agent.materialProgress).toMatchObject({
        state: "progressing",
        continuationBoundarySeq: 1,
        lastMaterialProgressKind: "assistant_result",
      });

      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "compaction",
        status: "completed",
      });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "compaction",
        status: "completed",
      });

      const stalled = await ctx.client.fetchAgent({ agentId: agent.id });
      expect(stalled?.agent.materialProgress).toMatchObject({
        state: "stalled",
        completedCompactionsSinceMaterialProgress: 2,
        lastMaterialProgressKind: "assistant_result",
      });

      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: "read-after-compactions",
        name: "read",
        status: "completed",
        error: null,
        detail: { type: "read", filePath: "proof.txt", content: "fresh evidence" },
      });
      const recovered = await ctx.client.fetchAgent({ agentId: agent.id });
      expect(recovered?.agent.materialProgress).toMatchObject({
        state: "progressing",
        completedCompactionsSinceMaterialProgress: 0,
        lastMaterialProgressKind: "evidence",
      });

      await ctx.daemon.daemon.agentManager.archiveAgent(agent.id);
      const archived = await ctx.client.fetchAgent({ agentId: agent.id });
      expect(archived?.agent.status).toBe("closed");
      expect(archived?.agent.materialProgress).toEqual(recovered?.agent.materialProgress);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);
});
