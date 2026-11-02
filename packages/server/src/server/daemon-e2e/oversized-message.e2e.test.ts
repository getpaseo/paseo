import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 60000);

describe("a message larger than the daemon accepts", () => {
  const oversizedImage = { data: "A".repeat(101 * 1024 * 1024), mimeType: "image/png" };

  test("fails the creation and keeps the connection up", async () => {
    const statuses: string[] = [];
    const unsubscribe = ctx.client.subscribeConnectionStatus((state) => {
      statuses.push(state.status);
    });

    await expect(
      ctx.client.createAgent({
        provider: "claude",
        cwd,
        title: "Oversized first message",
        initialPrompt: "Describe these screens.",
        images: [oversizedImage],
      }),
    ).rejects.toThrow(/too large/);
    unsubscribe();

    expect(statuses).toEqual(["connected"]);
    expect((await ctx.client.fetchAgents()).entries).toEqual([]);
  }, 30000);

  test("fails the send and keeps the connection up", async () => {
    const agent = await ctx.client.createAgent({ provider: "claude", cwd, title: "Agent" });
    const statuses: string[] = [];
    const unsubscribe = ctx.client.subscribeConnectionStatus((state) => {
      statuses.push(state.status);
    });

    await expect(
      ctx.client.sendMessage(agent.id, "Describe these screens.", { images: [oversizedImage] }),
    ).rejects.toThrow(/too large/);
    unsubscribe();

    expect(statuses).toEqual(["connected"]);
  }, 30000);
});
