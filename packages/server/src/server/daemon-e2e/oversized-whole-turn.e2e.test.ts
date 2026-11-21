import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createDaemonTestContext } from "../test-utils/index.js";

// #8458: a whole-turn page is one logical message, so a turn above the message limit never arrived.
test("reading a turn larger than the message limit returns pages that reach its start", async () => {
  const ctx = await createDaemonTestContext();
  const cwd = mkdtempSync(path.join(tmpdir(), "oversized-whole-turn-"));
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    const replies = 420;
    for (let index = 0; index < replies; index += 1) {
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        messageId: `reply-${index}`,
        text: `reply-${index} ${"x".repeat(250 * 1024)}`,
      });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "tool_call",
        callId: `call-${index}`,
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: `echo ${index}`, output: `${index}` },
      });
    }

    let page = await ctx.client.fetchAgentTimeline(agent.id, {
      direction: "tail",
      limit: 40,
      wholeTurns: true,
      timeout: 20_000,
    });
    const seen = new Set<string>();
    const collect = () => {
      for (const entry of page.entries) {
        if (entry.item.type === "assistant_message") seen.add(entry.item.text.split(" ")[0]);
      }
    };
    collect();
    expect(page.entries.length).toBeGreaterThan(0);
    while (page.hasOlder) {
      const cursor = page.startCursor;
      if (!cursor) throw new Error("page with older history has no start cursor");
      page = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "before",
        cursor,
        limit: 40,
        wholeTurns: true,
        timeout: 20_000,
      });
      collect();
    }
    expect(seen.size).toBe(replies);

    const small = await ctx.client.fetchAgentTimeline(agent.id, { direction: "tail", limit: 1 });
    expect(small.entries).toHaveLength(1);
  } finally {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180_000);

// A tail page starts at the first row of the source span it lands in. One tool call that starts
// before the oversized turn and completes after it spans every row, so no smaller page exists.
// The daemon answers with an error instead of letting the request time out.
test("reading a turn that one tool call spans past the message limit fails with a reply", async () => {
  const ctx = await createDaemonTestContext();
  const cwd = mkdtempSync(path.join(tmpdir(), "oversized-spanned-turn-"));
  try {
    const agent = await ctx.client.createAgent({ provider: "codex", cwd });
    const background = (status: "running" | "completed") => ({
      type: "tool_call" as const,
      callId: "background",
      name: "Bash",
      status,
      error: null,
      detail: { type: "shell" as const, command: "sleep 600" },
    });
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, background("running"));
    for (let index = 0; index < 420; index += 1) {
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "assistant_message",
        messageId: `reply-${index}`,
        text: `reply-${index} ${"x".repeat(250 * 1024)}`,
      });
    }
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, background("completed"));

    await expect(
      ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 40,
        wholeTurns: true,
        timeout: 20_000,
      }),
    ).rejects.toThrow(/one item spans more than the response size limit/i);

    const small = await ctx.client.fetchAgentTimeline(agent.id, { direction: "before", limit: 1 });
    expect(small.entries).toHaveLength(1);
  } finally {
    await ctx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180_000);
