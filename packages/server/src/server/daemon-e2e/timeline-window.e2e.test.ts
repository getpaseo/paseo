import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDaemonTestContext, type DaemonTestContext } from "../test-utils/index.js";

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-e2e-"));
}

async function appendToolLifecycleAcrossCursor(
  ctx: DaemonTestContext,
  agentId: string,
): Promise<void> {
  await ctx.daemon.daemon.agentManager.appendTimelineItem(agentId, {
    type: "tool_call",
    callId: "call_1",
    name: "shell",
    status: "running",
    error: null,
    detail: {
      type: "unknown",
      input: { cmd: "sleep 10" },
      output: null,
    },
  });
  for (let seq = 2; seq <= 249; seq += 1) {
    await ctx.daemon.daemon.agentManager.appendTimelineItem(agentId, {
      type: "assistant_message",
      text: `background ${seq}`,
    });
  }
  await ctx.daemon.daemon.agentManager.appendTimelineItem(agentId, {
    type: "tool_call",
    callId: "call_1",
    name: "shell",
    status: "completed",
    error: null,
    detail: {
      type: "unknown",
      input: { cmd: "sleep 10" },
      output: { stdout: "done" },
    },
  });
}

describe("daemon E2E - timeline window", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.cleanup();
  }, 60_000);

  test.each([
    {
      direction: "tail" as const,
      limit: 0,
      cursorSeq: 8,
      expectedStart: 5,
      nextDirection: "before" as const,
      nextCursor: 5,
      nextStart: 1,
    },
    {
      direction: "before" as const,
      limit: 0,
      cursorSeq: 9,
      expectedStart: 5,
      nextDirection: "before" as const,
      nextCursor: 5,
      nextStart: 1,
    },
    {
      direction: "after" as const,
      limit: 0,
      cursorSeq: 0,
      expectedStart: 1,
      nextDirection: "after" as const,
      nextCursor: 4,
      nextStart: 5,
    },
    {
      direction: "after" as const,
      limit: undefined,
      cursorSeq: 0,
      expectedStart: 1,
      nextDirection: "after" as const,
      nextCursor: 4,
      nextStart: 5,
    },
  ])(
    "bounds image history by bytes for $direction with limit $limit and preserves continuation",
    async ({
      direction,
      limit,
      cursorSeq,
      expectedStart,
      nextDirection,
      nextCursor,
      nextStart,
    }) => {
      const cwd = tmpCwd();
      const image = { data: "A".repeat(3 * 1024 * 1024), mimeType: "image/png" };
      try {
        const agent = await ctx.client.createAgent({ provider: "codex", cwd });
        for (let index = 1; index <= 8; index += 1) {
          await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
            type: "user_message",
            text: `image ${index}`,
            images: [image],
          });
        }
        const epoch = ctx.daemon.daemon.agentManager.fetchTimeline(agent.id, { limit: 1 }).epoch;
        const page = await ctx.client.fetchAgentTimeline(agent.id, {
          direction,
          cursor: { epoch, seq: cursorSeq },
          limit,
        });
        expect(page.entries).toHaveLength(4);
        expect(page.entries.map((entry) => entry.item)).toEqual(
          Array.from({ length: 4 }, (_, index) => ({
            type: "user_message",
            text: `image ${expectedStart + index}`,
            images: [image],
          })),
        );
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024 * 1024);
        expect(page.startCursor).toEqual({ epoch, seq: expectedStart });
        expect(page.endCursor).toEqual({ epoch, seq: expectedStart + 3 });
        const next = await ctx.client.fetchAgentTimeline(agent.id, {
          direction: nextDirection,
          cursor: { epoch, seq: nextCursor },
          limit,
        });
        expect(next.entries).toHaveLength(4);
        expect(next.entries.map((entry) => entry.item)).toEqual(
          Array.from({ length: 4 }, (_, index) => ({
            type: "user_message",
            text: `image ${nextStart + index}`,
            images: [image],
          })),
        );
        expect((await ctx.client.fetchAgent(agent.id))?.agent.id).toBe(agent.id);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  test("uses retained pager defaults for image history when after limit is omitted", async () => {
    const cwd = tmpCwd();
    const image = { data: "AA==", mimeType: "image/png" };
    try {
      const agent = await ctx.client.createAgent({ provider: "codex", cwd });
      for (let index = 1; index <= 300; index += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `image ${index}`,
          images: [image],
        });
      }
      const epoch = ctx.daemon.daemon.agentManager.fetchTimeline(agent.id, { limit: 1 }).epoch;
      const first = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch, seq: 0 },
      });
      expect(first.entries).toHaveLength(200);
      expect(first.entries.map((entry) => entry.item)).toEqual(
        Array.from({ length: 200 }, (_, index) => ({
          type: "user_message",
          text: `image ${index + 1}`,
          images: [image],
        })),
      );
      const cursor = { epoch, seq: 200 };
      expect(first.startCursor).toEqual({ epoch, seq: 1 });
      expect(first.endCursor).toEqual(cursor);
      expect(first.hasNewer).toBe(true);
      const next = await ctx.client.fetchAgentTimeline(agent.id, { direction: "after", cursor });
      expect(next.entries.map((entry) => entry.item)).toEqual(
        Array.from({ length: 100 }, (_, index) => ({
          type: "user_message",
          text: `image ${index + 201}`,
          images: [image],
        })),
      );
      expect(next.startCursor).toEqual({ epoch, seq: 201 });
      expect(next.endCursor).toEqual({ epoch, seq: 300 });
      expect(next.hasNewer).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test.each(["tail", "before"] as const)(
    "keeps image prompts with their complete response for whole-turn %s pages",
    async (direction) => {
      const cwd = tmpCwd();
      try {
        const agent = await ctx.client.createAgent({ provider: "codex", cwd });
        const image = { data: "AA==", mimeType: "image/png" };
        const items = [
          { type: "user_message" as const, text: "older prompt" },
          { type: "assistant_message" as const, text: "older response" },
          { type: "user_message" as const, text: "image prompt", images: [image] },
          { type: "assistant_message" as const, text: "image response" },
        ];
        for (const item of items)
          await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, item);
        const epoch = ctx.daemon.daemon.agentManager.fetchTimeline(agent.id, { limit: 1 }).epoch;
        const page = await ctx.client.fetchAgentTimeline(agent.id, {
          direction,
          limit: 1,
          wholeTurns: true,
          ...(direction === "before" ? { cursor: { epoch, seq: 4 } } : {}),
        });
        expect(page.entries.map((entry) => entry.item)).toEqual(items.slice(2));
        expect(page.startCursor).toEqual({ epoch, seq: 3 });
        expect(page.endCursor).toEqual({ epoch, seq: 4 });
        expect(page.hasOlder).toBe(true);
        expect(page.hasNewer).toBe(false);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(16 * 1024 * 1024);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

  test("rejects an oversized timeline item without disconnecting", async () => {
    const cwd = tmpCwd();
    const statuses: string[] = [];
    const unsubscribe = ctx.client.subscribeConnectionStatus((state) =>
      statuses.push(state.status),
    );
    try {
      const agent = await ctx.client.createAgent({ provider: "codex", cwd });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "oversized image",
        images: [{ data: "A".repeat(17 * 1024 * 1024), mimeType: "image/png" }],
      });
      await expect(ctx.client.fetchAgentTimeline(agent.id)).rejects.toThrow(
        "exceeds the 16 MiB history page limit",
      );
      expect((await ctx.client.fetchAgent(agent.id))?.agent.id).toBe(agent.id);
      expect(statuses).toEqual(["connected"]);
    } finally {
      unsubscribe();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("does not split an oversized timeline group across lifecycle coverage", async () => {
    const cwd = tmpCwd();
    const image = { data: "A".repeat(9 * 1024 * 1024), mimeType: "image/png" };
    try {
      const agent = await ctx.client.createAgent({ provider: "codex", cwd });
      const tool = {
        type: "tool_call" as const,
        callId: "interleaved",
        name: "shell",
        error: null,
        detail: { type: "unknown" as const, input: null, output: null },
      };
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        ...tool,
        status: "running",
      });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "first image",
        images: [image],
      });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "second image",
        images: [image],
      });
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        ...tool,
        status: "completed",
      });
      await expect(ctx.client.fetchAgentTimeline(agent.id, { limit: 1 })).rejects.toThrow(
        "inseparable history group",
      );
      expect((await ctx.client.fetchAgent(agent.id))?.agent.id).toBe(agent.id);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("canonical tail limit returns one finalized committed assistant row at the window boundary", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Window Boundary Test",
        modeId: "full-access",
      });

      const expected = "READY";
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

      expect(assistantTexts).toEqual([expected]);
      expect(timeline.startCursor?.seq).toBe(timeline.endCursor?.seq);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 30_000);

  test("canonical tail limit does not widen to full history once boundary is resolved", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Window Scope Test",
        modeId: "full-access",
      });

      await ctx.client.sendMessage(agent.id, "Respond with exactly: FIRST");
      expect((await ctx.client.waitForFinish(agent.id, 5_000)).status).toBe("idle");

      const expected = "SECOND";
      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "next",
      });
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
  }, 30_000);

  test("timeline fetch returns one projected in-progress tool call instead of lifecycle deltas", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Tool Projection Test",
        modeId: "full-access",
      });

      await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
        type: "user_message",
        text: "run the tool",
      });
      for (let index = 0; index < 120; index += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "tool_call",
          callId: "call_1",
          name: "shell",
          status: "running",
          error: null,
          detail: {
            type: "unknown",
            input: { cmd: "sleep 10" },
            output: { progress: index },
          },
        });
      }

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 100,
        projection: "projected",
      });

      const toolEntries = timeline.entries.filter((entry) => entry.item.type === "tool_call");
      expect(timeline.projection).toBe("projected");
      expect(timeline.entries.map((entry) => entry.item.type)).toEqual([
        "user_message",
        "tool_call",
      ]);
      expect(toolEntries).toHaveLength(1);
      expect(toolEntries[0]?.collapsed).toContain("tool_lifecycle");
      expect(toolEntries[0]?.sourceSeqRanges).toEqual([{ startSeq: 2, endSeq: 121 }]);
      expect(timeline.endCursor?.seq).toBe(121);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("legacy canonical requests return full projected items after the cursor", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Canonical Catch-up Test",
        modeId: "full-access",
      });

      await appendToolLifecycleAcrossCursor(ctx, agent.id);

      const baseline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
      });
      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch: baseline.epoch, seq: 249 },
        limit: 100,
        projection: "canonical",
      });

      expect(timeline.projection).toBe("projected");
      expect(timeline.entries).toHaveLength(1);
      expect(timeline.startCursor?.seq).toBe(250);
      expect(timeline.endCursor?.seq).toBe(250);
      expect(timeline.entries[0]?.seqStart).toBe(1);
      expect(timeline.entries[0]?.seqEnd).toBe(250);
      expect(timeline.entries[0]?.sourceSeqRanges).toEqual([
        { startSeq: 1, endSeq: 1 },
        { startSeq: 250, endSeq: 250 },
      ]);
      expect(timeline.entries[0]?.item.type).toBe("tool_call");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("projected after fetch returns the full projected tool item for a new lifecycle update", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Tool Catch-up Test",
        modeId: "full-access",
      });

      await appendToolLifecycleAcrossCursor(ctx, agent.id);

      const baseline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 0,
      });
      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch: baseline.epoch, seq: 249 },
        limit: 100,
        projection: "projected",
      });

      expect(timeline.projection).toBe("projected");
      expect(timeline.entries).toHaveLength(1);
      expect(timeline.startCursor?.seq).toBe(250);
      expect(timeline.endCursor?.seq).toBe(250);
      expect(timeline.entries[0]?.seqStart).toBe(1);
      expect(timeline.entries[0]?.seqEnd).toBe(250);
      expect(timeline.entries[0]?.sourceSeqRanges).toEqual([
        { startSeq: 1, endSeq: 1 },
        { startSeq: 250, endSeq: 250 },
      ]);
      expect(timeline.entries[0]?.item.type).toBe("tool_call");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reset timeline fetch reports older history when the reset slice starts after window min", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Reset HasOlder Test",
        modeId: "full-access",
      });

      for (let seq = 1; seq <= 600; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `row ${seq}`,
        });
      }

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        cursor: { epoch: "stale-epoch", seq: 600 },
        limit: 200,
      });

      expect(timeline.reset).toBe(true);
      expect(timeline.staleCursor).toBe(true);
      expect(timeline.startCursor?.seq).toBeGreaterThan(timeline.window.minSeq);
      expect(timeline.hasOlder).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("tail fetch does not re-fetch full plain chat history", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Tail Bounded Fetch Test",
        modeId: "full-access",
      });
      for (let seq = 1; seq <= 600; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `row ${seq}`,
        });
      }

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 100,
      });

      expect(timeline.entries).toHaveLength(100);
      expect(timeline.startCursor?.seq).toBe(501);
      expect(timeline.endCursor?.seq).toBe(600);
      expect(timeline.hasOlder).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("after fetch does not re-fetch full plain chat history", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline After Bounded Fetch Test",
        modeId: "full-access",
      });
      for (let seq = 1; seq <= 600; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `row ${seq}`,
        });
      }
      const epoch = ctx.daemon.daemon.agentManager.fetchTimeline(agent.id, {
        direction: "tail",
        limit: 1,
      }).epoch;

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch, seq: 300 },
        limit: 100,
      });

      expect(timeline.entries).toHaveLength(100);
      expect(timeline.startCursor?.seq).toBe(301);
      expect(timeline.endCursor?.seq).toBe(400);
      expect(timeline.hasNewer).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("projected after limit returns 100 projected entries with their canonical coverage", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Projected Page Limit Test",
        modeId: "full-access",
      });
      for (let seq = 1; seq <= 200; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "assistant_message",
          text: "x",
        });
      }
      for (let seq = 201; seq <= 350; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `message ${seq - 200}`,
        });
      }
      const epoch = ctx.daemon.daemon.agentManager.fetchTimeline(agent.id, {
        direction: "tail",
        limit: 1,
      }).epoch;

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch, seq: 0 },
        limit: 100,
        projection: "projected",
      });

      expect({
        entryCount: timeline.entries.length,
        firstEntry: timeline.entries[0],
        lastEntry: timeline.entries.at(-1),
        startCursor: timeline.startCursor,
        endCursor: timeline.endCursor,
        hasNewer: timeline.hasNewer,
      }).toEqual({
        entryCount: 100,
        firstEntry: {
          provider: "codex",
          item: { type: "assistant_message", text: "x".repeat(200) },
          timestamp: expect.any(String),
          seqStart: 1,
          seqEnd: 200,
          sourceSeqRanges: [{ startSeq: 1, endSeq: 200 }],
          collapsed: ["assistant_merge"],
        },
        lastEntry: {
          provider: "codex",
          item: { type: "user_message", text: "message 99" },
          timestamp: expect.any(String),
          seqStart: 299,
          seqEnd: 299,
          sourceSeqRanges: [{ startSeq: 299, endSeq: 299 }],
          collapsed: [],
        },
        startCursor: { epoch, seq: 1 },
        endCursor: { epoch, seq: 299 },
        hasNewer: true,
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("projected empty after fetch preserves older history availability", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Empty After HasOlder Test",
        modeId: "full-access",
      });
      for (let seq = 1; seq <= 160; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `row ${seq}`,
        });
      }

      const tail = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 100,
        projection: "projected",
      });
      expect(tail.hasOlder).toBe(true);
      expect(tail.startCursor?.seq).toBe(61);
      expect(tail.endCursor?.seq).toBe(160);

      const after = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch: tail.epoch, seq: tail.endCursor?.seq ?? 160 },
        limit: 100,
        projection: "projected",
      });

      expect(after.entries).toHaveLength(0);
      expect(after.hasOlder).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("before fetch does not re-fetch full plain chat history", async () => {
    const cwd = tmpCwd();
    try {
      const agent = await ctx.client.createAgent({
        provider: "codex",
        cwd,
        title: "Timeline Before Bounded Fetch Test",
        modeId: "full-access",
      });
      for (let seq = 1; seq <= 600; seq += 1) {
        await ctx.daemon.daemon.agentManager.appendTimelineItem(agent.id, {
          type: "user_message",
          text: `row ${seq}`,
        });
      }
      const epoch = ctx.daemon.daemon.agentManager.fetchTimeline(agent.id, {
        direction: "tail",
        limit: 1,
      }).epoch;

      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "before",
        cursor: { epoch, seq: 501 },
        limit: 100,
      });

      expect(timeline.entries).toHaveLength(100);
      expect(timeline.startCursor?.seq).toBe(401);
      expect(timeline.endCursor?.seq).toBe(500);
      expect(timeline.hasOlder).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
