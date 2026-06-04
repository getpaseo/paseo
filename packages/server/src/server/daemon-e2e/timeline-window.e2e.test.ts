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

  test("canonical after fetch returns only committed rows after the cursor", async () => {
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

      expect(timeline.projection).toBe("canonical");
      expect(timeline.entries).toHaveLength(1);
      expect(timeline.startCursor?.seq).toBe(250);
      expect(timeline.endCursor?.seq).toBe(250);
      expect(timeline.entries[0]?.seqStart).toBe(250);
      expect(timeline.entries[0]?.seqEnd).toBe(250);
      expect(timeline.entries[0]?.sourceSeqRanges).toEqual([{ startSeq: 250, endSeq: 250 }]);
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

      const fetchSpy = vi.spyOn(ctx.daemon.daemon.agentManager, "fetchTimeline");
      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "tail",
        limit: 100,
      });

      expect(timeline.entries).toHaveLength(100);
      expect(timeline.startCursor?.seq).toBe(501);
      expect(timeline.endCursor?.seq).toBe(600);
      expect(timeline.hasOlder).toBe(true);
      expect(
        fetchSpy.mock.calls.some(
          ([, options]) => options?.direction === "tail" && options.limit === 0,
        ),
      ).toBe(false);
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

      const fetchSpy = vi.spyOn(ctx.daemon.daemon.agentManager, "fetchTimeline");
      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "after",
        cursor: { epoch, seq: 300 },
        limit: 100,
      });

      expect(timeline.entries).toHaveLength(100);
      expect(timeline.startCursor?.seq).toBe(301);
      expect(timeline.endCursor?.seq).toBe(400);
      expect(timeline.hasNewer).toBe(true);
      expect(
        fetchSpy.mock.calls.some(
          ([, options]) => options?.direction === "tail" && options.limit === 0,
        ),
      ).toBe(false);
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

      const fetchSpy = vi.spyOn(ctx.daemon.daemon.agentManager, "fetchTimeline");
      const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
        direction: "before",
        cursor: { epoch, seq: 501 },
        limit: 100,
      });

      expect(timeline.entries).toHaveLength(100);
      expect(timeline.startCursor?.seq).toBe(401);
      expect(timeline.endCursor?.seq).toBe(500);
      expect(timeline.hasOlder).toBe(true);
      expect(
        fetchSpy.mock.calls.some(
          ([, options]) => options?.direction === "tail" && options.limit === 0,
        ),
      ).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
