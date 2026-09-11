import { afterEach, expect, it } from "vitest";
import {
  createDaemonTestContext,
  type DaemonTestContext,
} from "../test-utils/daemon-test-context.js";
import { DaemonClient } from "../test-utils/daemon-client.js";

let ctx: DaemonTestContext | undefined;
afterEach(async () => {
  await ctx?.cleanup();
});

it("delivers summaries and retained detail across reconnect without exposing helpers as agents", async () => {
  ctx = await createDaemonTestContext();
  const manager = ctx.daemon.daemon.agentManager;
  const recorder = manager.backgroundActivity;
  const before = recorder.create({ kind: "commit", title: "Commit", cwd: "/tmp" });
  expect((await ctx.client.getBackgroundActivity()).requests.map((r) => r.id)).toContain(before);
  let revision = 0;
  const stop = ctx.client.subscribeRawMessages((message) => {
    if (message.type === "background.activity.changed") revision = message.payload.revision;
  });
  await ctx.client.setBackgroundActivitySubscription("index", true);
  const agent = await manager.createAgent(
    { provider: "codex", cwd: "/tmp", internal: true, modeId: "full-access" },
    undefined,
    { persistSession: false, workspaceId: undefined },
  );
  const finish = recorder.capture(manager, before, agent.id, "echo background");
  await manager.runAgent(agent.id, "echo background");
  finish();
  recorder.finish(before);
  await expect.poll(() => revision).toBeGreaterThan(0);
  const snapshot = await ctx.client.getBackgroundActivity(agent.id);
  expect(snapshot.rows.length).toBeGreaterThan(1);
  expect(snapshot.requests[0].status).toBe("completed");
  await ctx.client.setBackgroundActivitySubscription("index", false);
  stop();
  await manager.closeAgent(agent.id);
  await manager.deleteAgentState(agent.id);
  expect(manager.listAgents()).toEqual([]);
  await ctx.client.close();
  const reconnected = new DaemonClient({ url: `ws://127.0.0.1:${ctx.daemon.port}/ws` });
  try {
    await reconnected.connect();
    const retained = await reconnected.getBackgroundActivity(agent.id);
    expect(retained.epoch).toBe(snapshot.epoch);
    expect(retained.rows).toEqual(snapshot.rows);
    expect(
      (await reconnected.getBackgroundActivity(agent.id, retained.rows.at(-1)!.seq)).rows,
    ).toEqual([]);
  } finally {
    await reconnected.close();
  }
});
