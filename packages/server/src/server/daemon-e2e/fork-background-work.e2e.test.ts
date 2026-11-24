import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

let ctx: DaemonTestContext;
let cwd: string;

beforeEach(async () => {
  ctx = await createDaemonTestContext();
  cwd = mkdtempSync(path.join(tmpdir(), "fork-background-work-"));
});

afterEach(async () => {
  await ctx.cleanup();
  rmSync(cwd, { recursive: true, force: true });
}, 30_000);

test("forks from a reply that background work outlived", async () => {
  const agent = await ctx.client.createAgent({ provider: "claude", cwd });
  await ctx.client.sendMessage(agent.id, "Start background work");
  expect((await ctx.client.waitForFinish(agent.id, 15_000)).status).toBe("idle");
  await ctx.client.sendMessage(agent.id, "Any findings?");
  expect((await ctx.client.waitForFinish(agent.id, 15_000)).status).toBe("idle");

  const page = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 0 });
  const reply = page.entries.find(
    (entry) => entry.item.type === "assistant_message" && entry.item.text === "Audit started.",
  );
  if (reply?.item.type !== "assistant_message" || !reply.item.messageId) {
    throw new Error("Expected the reply to carry a provider message id");
  }
  const task = page.entries.find((entry) => entry.item.type === "tool_call");
  // The Task row started before the reply and completed after it.
  expect(task?.item).toMatchObject({ name: "Task", status: "completed" });
  expect(task?.seqStart).toBeLessThan(reply.seqEnd);
  expect(task?.seqEnd).toBeGreaterThan(reply.seqEnd);

  const byMessage = await ctx.client.buildAgentForkContext(agent.id, {
    boundaryMessageId: reply.item.messageId,
  });
  const byCursor = await ctx.client.buildAgentForkContext(agent.id, {
    boundaryCursor: { epoch: page.epoch, seq: reply.seqEnd },
  });

  for (const fork of [byMessage, byCursor]) {
    expect(fork.itemCount).toBe(3);
    expect(fork.attachment?.text).toContain(
      "[User] Start background work\n[Explore] Audit the migrations\n[Assistant] Audit started.\n",
    );
    expect(fork.attachment?.text).not.toContain("Any findings?");
  }
  expect(byMessage.boundaryMessageId).toBe(reply.item.messageId);
  expect(byCursor.boundaryCursor).toEqual({ epoch: page.epoch, seq: reply.seqEnd });
}, 60_000);
