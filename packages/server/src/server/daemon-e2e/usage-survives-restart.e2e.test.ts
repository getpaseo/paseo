import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

describe("daemon E2E - usage after restart", () => {
  let ctx: DaemonTestContext | null = null;
  const dirs: string[] = [];

  afterEach(async () => {
    await ctx?.cleanup();
    ctx = null;
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test("a finished agent reports its last usage after the daemon restarts", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "usage-restart-cwd-"));
    const paseoHomeRoot = mkdtempSync(path.join(tmpdir(), "usage-restart-home-"));
    dirs.push(cwd, paseoHomeRoot);

    ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd,
      title: "Usage restart agent",
      modeId: "full-access",
    });
    await ctx.client.sendMessage(agent.id, "Say 'done' and nothing else");
    const finished = await ctx.client.waitForFinish(agent.id, 5_000);
    expect(finished.status).toBe("idle");
    const usageBeforeRestart = finished.final?.lastUsage;
    expect(usageBeforeRestart).toBeDefined();

    await ctx.cleanup();
    ctx = await createDaemonTestContext({ paseoHomeRoot, cleanup: false });

    const stored = await ctx.client.fetchAgent(agent.id);
    expect(stored?.agent.lastUsage).toEqual(usageBeforeRestart);

    await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
    const reopened = await ctx.client.fetchAgent(agent.id);
    expect(reopened?.agent.status).toBe("idle");
    expect(reopened?.agent.lastUsage).toEqual(usageBeforeRestart);
  }, 30_000);
});
