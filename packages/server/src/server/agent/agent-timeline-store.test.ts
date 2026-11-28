import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectReferenceProjectedTimelinePage } from "./test-utils/timeline-page-reference.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("keeps a streaming assistant message whole when a steering prompt is recorded mid-stream", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1");
    store.append("agent-1", {
      type: "assistant_message",
      text: "with the uncommit",
      messageId: "msg-1",
    });
    store.append("agent-1", { type: "user_message", text: "keep going" });
    store.append("agent-1", {
      type: "assistant_message",
      text: "ted changes.",
      messageId: "msg-1",
    });

    expect(store.getItems("agent-1")).toEqual([
      { type: "assistant_message", text: "with the uncommitted changes.", messageId: "msg-1" },
      { type: "user_message", text: "keep going" },
    ]);
  });

  it("keeps text written after a tool call below it when both share a message id", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1");
    store.append("agent-1", { type: "assistant_message", text: "Let me check.", messageId: "m1" });
    store.append("agent-1", {
      type: "tool_call",
      callId: "c1",
      name: "shell",
      status: "completed",
      detail: { type: "unknown", input: null, output: null },
      error: null,
    });
    store.append("agent-1", { type: "assistant_message", text: "Found it.", messageId: "m1" });

    expect(store.getItems("agent-1").map((item) => item.type)).toEqual([
      "assistant_message",
      "tool_call",
      "assistant_message",
    ]);
  });

  it("keeps chunks without a message id apart when a user message is recorded between them", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1");
    store.append("agent-1", { type: "assistant_message", text: "First." });
    store.append("agent-1", { type: "user_message", text: "keep going" });
    store.append("agent-1", { type: "assistant_message", text: "Second." });

    expect(store.getItems("agent-1")).toEqual([
      { type: "assistant_message", text: "First." },
      { type: "user_message", text: "keep going" },
      { type: "assistant_message", text: "Second." },
    ]);
  });

  it("resets stale forward cursors to complete available turns", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "current" });
    for (let index = 0; index < 60; index++)
      store.append(
        "agent",
        {
          type: "tool_call",
          callId: `call-${index}`,
          name: "shell",
          status: "completed",
          error: null,
          detail: { type: "unknown", input: null, output: null },
        },
        { turnId: "run" },
      );
    const page = store.fetch("agent", {
      direction: "after",
      cursor: { epoch: "old", seq: 10 },
      limit: 40,
      wholeTurns: true,
    });
    expect(page.rows).toHaveLength(60);
    expect(page).toMatchObject({
      reset: true,
      staleCursor: true,
      startSeq: 1,
      endSeq: 60,
      hasOlder: false,
      hasNewer: false,
    });
  });

  it("clamps an overshooting before cursor into the bounded tail window", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "before",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });

  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five", messageId: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six", messageId: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toMatchObject({
      epoch: "epoch-1",
      direction: "after",
      reset: true,
      staleCursor: false,
      gap: true,
      window: { minSeq: 5, maxSeq: 7, nextSeq: 8 },
      hasOlder: true,
      hasNewer: false,
      rows: [
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven", messageId: "seven" },
        },
      ],
    });
  });
});

describe("projected timeline retention", () => {
  it("retains one full tool state while streaming every source update", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent");
    for (let seq = 1; seq <= 2000; seq++) {
      const item = {
        type: "tool_call" as const,
        callId: "child",
        name: "task",
        status: "running" as const,
        error: null,
        detail: { type: "plain_text" as const, label: "Child", text: "x".repeat(seq * 128) },
      };
      expect(store.append("agent", item)).toMatchObject({ seq, item });
    }
    const result = store.fetch("agent", { limit: 0 });
    expect(result.rows).toHaveLength(1);
    expect(JSON.stringify(result.rows).length).toBeLessThan(260_000);
    expect(result.window.maxSeq).toBe(2000);
  });

  it("catches up a mid-message cursor with the complete projected message", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "e" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "A" });
    store.append("agent", { type: "assistant_message", messageId: "m", text: "B" });
    expect(
      store.fetch("agent", { direction: "after", cursor: { epoch: "e", seq: 1 } }).rows,
    ).toMatchObject([
      {
        item: { text: "AB" },
        seqStart: 1,
        seqEnd: 2,
        sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
      },
    ]);
  });

  it("serves a merged assistant message within the item budget", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent", { epoch: "e" });
    const chunk = "a".repeat(200 * 1024);
    for (let index = 0; index < 10; index++) {
      store.append("agent", { type: "assistant_message", messageId: "m", text: chunk });
    }
    const [row] = store.fetch("agent", { limit: 1 }).rows;
    expect(row).toMatchObject({ seqStart: 1, seqEnd: 10 });
    expect(row.item).toMatchObject({ type: "assistant_message", messageId: "m" });
    expect(Buffer.byteLength(JSON.stringify(row.item))).toBeLessThanOrEqual(256 * 1024);
    expect(store.getLastAssistantMessage("agent")).toHaveLength(10 * chunk.length);
  });
});

describe("projected sequence ownership", () => {
  it("preserves fetched coverage when another source chunk arrives", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", text: "A" });
    const before = store.fetch("a");
    store.append("a", { type: "assistant_message", text: "B" });
    expect(before.rows[0]).toMatchObject({
      item: { text: "A" },
      seqEnd: 1,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    });
    expect(store.fetch("a").rows[0]).toMatchObject({
      item: { text: "AB" },
      seqEnd: 2,
      sourceSeqRanges: [{ startSeq: 1, endSeq: 2 }],
    });
  });
  it("preserves source positions when seeding a projected history whose last update is an earlier tool", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    const tool = {
      type: "tool_call" as const,
      callId: "t",
      name: "shell",
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    };
    store.append("a", { ...tool, status: "running" });
    store.append("a", { type: "assistant_message", text: "Answer" });
    store.append("a", { ...tool, status: "completed" });
    store.initialize("b", { rows: store.getRows("a") });
    expect(store.getLastItem("b")).toMatchObject({ type: "tool_call", status: "completed" });
    expect(store.getLastAssistantMessage("b")).toBe("Answer");
    expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
    expect(store.getLastItem("b")).toEqual({ type: "user_message", text: "next" });
    expect(store.fetch("b").rows.map((row) => row.seqStart)).toEqual([1, 2, 4]);
  });
  it("returns the last projected assistant message without joining different messages", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "assistant_message", messageId: "first", text: "First" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "Sec" });
    store.append("a", { type: "assistant_message", messageId: "second", text: "ond" });
    expect(store.getLastAssistantMessage("a")).toBe("Second");
  });
});

describe("turn metrics", () => {
  const metrics = [
    { label: "Model", value: "gpt-5.5" },
    { label: "Cache", value: "82%", tone: "ok" as const },
  ];
  const tool = {
    type: "tool_call" as const,
    callId: "t",
    name: "shell",
    error: null,
    detail: { type: "plain_text" as const, label: "work" },
  };
  function turnMetricsByRow(store: InMemoryAgentTimelineStore, agentId: string) {
    return store.fetch(agentId).rows.map((row) => row.turnMetrics ?? null);
  }

  it("puts a turn's metrics on its last assistant message, where its footer shows", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "user_message", text: "go" }, { turnId: "turn-1" });
    store.append("a", { type: "assistant_message", text: "First" }, { turnId: "turn-1" });
    store.append("a", { ...tool, status: "completed" }, { turnId: "turn-1" });
    store.append("a", { type: "assistant_message", text: "Done" }, { turnId: "turn-1" });
    store.append("a", { type: "reasoning", text: "wrap up" }, { turnId: "turn-1" });

    const stamped = store.stampTurnMetrics("a", metrics, { turnId: "turn-1" });

    expect(stamped).toMatchObject({ seq: 4, item: { text: "Done" }, turnMetrics: metrics });
    expect(turnMetricsByRow(store, "a")).toEqual([null, null, null, metrics, null]);
  });

  it("falls back to the turn's last row when it is a tool call and no message was written", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "user_message", text: "go" });
    store.append("a", { type: "reasoning", text: "thinking" });
    store.append("a", { ...tool, status: "completed" });

    store.stampTurnMetrics("a", metrics);

    expect(turnMetricsByRow(store, "a")).toEqual([null, null, metrics]);
  });

  it("leaves the previous turn alone when the completed turn has no footer row", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "user_message", text: "one" });
    store.append("a", { type: "assistant_message", text: "Answer one" });
    store.append("a", { type: "user_message", text: "two" });
    store.append("a", { type: "reasoning", text: "thinking" });

    expect(store.stampTurnMetrics("a", metrics)).toBeNull();
    expect(turnMetricsByRow(store, "a")).toEqual([null, null, null, null]);
  });

  it("finds the completed turn by id when a newer turn already has rows", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "user_message", text: "one" }, { turnId: "turn-1" });
    store.append("a", { type: "assistant_message", text: "Answer one" }, { turnId: "turn-1" });
    store.append("a", { type: "user_message", text: "two" }, { turnId: "turn-2" });
    store.append("a", { type: "assistant_message", text: "Answer two" }, { turnId: "turn-2" });

    store.stampTurnMetrics("a", metrics, { turnId: "turn-1" });

    expect(turnMetricsByRow(store, "a")).toEqual([null, metrics, null, null]);
  });

  it("stamps nothing for a turn that wrote no rows instead of the turn before it", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "user_message", text: "one" }, { turnId: "turn-1" });
    store.append("a", { type: "assistant_message", text: "Answer one" }, { turnId: "turn-1" });

    expect(store.stampTurnMetrics("a", metrics, { turnId: "turn-2" })).toBeNull();
    expect(turnMetricsByRow(store, "a")).toEqual([null, null]);
  });

  it("keeps the metrics when a late update lands on the stamped row", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    store.append("a", { type: "user_message", text: "go" }, { turnId: "turn-1" });
    store.append("a", { ...tool, status: "running" }, { turnId: "turn-1" });
    store.stampTurnMetrics("a", metrics, { turnId: "turn-1" });

    store.append("a", { ...tool, status: "completed" }, { turnId: "turn-1" });

    expect(store.fetch("a").rows[1]).toMatchObject({
      item: { status: "completed" },
      turnMetrics: metrics,
    });
  });

  it("keeps the stats on a message whose chunks the projection merges", () => {
    const store = new InMemoryAgentTimelineStore();
    const at = "2026-11-22T00:00:00.000Z";
    store.initialize("a", {
      rows: [
        { seq: 1, timestamp: at, item: { type: "user_message", text: "go" } },
        { seq: 2, timestamp: at, item: { type: "assistant_message", text: "Do" } },
        {
          seq: 3,
          timestamp: at,
          item: { type: "assistant_message", text: "ne" },
          turnMetrics: metrics,
        },
      ],
    });

    const rows = store.fetch("a").rows;

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ item: { text: "Done" }, turnMetrics: metrics });
  });

  it("keeps the stats on a steered message whose chunks carry a message id", () => {
    const store = new InMemoryAgentTimelineStore();
    const at = "2026-11-22T00:00:00.000Z";
    store.initialize("a", {
      rows: [
        { seq: 1, timestamp: at, item: { type: "user_message", text: "go" } },
        { seq: 2, timestamp: at, item: { type: "assistant_message", text: "Do", messageId: "m1" } },
        { seq: 3, timestamp: at, item: { type: "assistant_message", text: "n", messageId: "m1" } },
        { seq: 4, timestamp: at, item: { type: "user_message", text: "keep going" } },
        {
          seq: 5,
          timestamp: at,
          item: { type: "assistant_message", text: "e", messageId: "m1" },
          turnMetrics: metrics,
        },
      ],
    });

    const rows = store.fetch("a").rows;

    expect(rows.map((row) => row.item)).toEqual([
      { type: "user_message", text: "go" },
      { type: "assistant_message", text: "Done", messageId: "m1" },
      { type: "user_message", text: "keep going" },
    ]);
    expect(rows[1]).toMatchObject({ turnMetrics: metrics });
  });

  it("keeps the stats on a tool card whose updates the projection merges", () => {
    const store = new InMemoryAgentTimelineStore();
    const at = "2026-11-22T00:00:00.000Z";
    store.initialize("a", {
      rows: [
        { seq: 1, timestamp: at, item: { type: "user_message", text: "go" } },
        { seq: 2, timestamp: at, item: { ...tool, status: "running" } },
        { seq: 3, timestamp: at, item: { ...tool, status: "completed" }, turnMetrics: metrics },
      ],
    });

    const rows = store.fetch("a").rows;

    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ item: { status: "completed" }, turnMetrics: metrics });
  });

  it("restores stamped rows when a timeline is seeded from stored rows", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("live");
    store.append("live", { type: "user_message", text: "go" });
    store.append("live", { type: "assistant_message", text: "Done" });
    store.stampTurnMetrics("live", metrics);

    store.initialize("projected", { rows: store.getRows("live") });
    store.initialize("canonical", {
      rows: [
        {
          seq: 1,
          timestamp: "2026-11-22T00:00:00.000Z",
          item: { type: "user_message", text: "go" },
        },
        {
          seq: 2,
          timestamp: "2026-11-22T00:00:01.000Z",
          item: { type: "assistant_message", text: "Done" },
          turnMetrics: metrics,
        },
      ],
    });

    expect(turnMetricsByRow(store, "projected")).toEqual([null, metrics]);
    expect(turnMetricsByRow(store, "canonical")).toEqual([null, metrics]);
  });
});

it("includes transitive tool updates in a contiguous projected tail", () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a");
  const tool = (callId: string, status: "running" | "completed") => ({
    type: "tool_call" as const,
    callId,
    name: "shell",
    status,
    error: null,
    detail: { type: "plain_text" as const, label: "work" },
  });
  store.append("a", tool("first", "running"));
  store.append("a", tool("second", "running"));
  store.append("a", { type: "user_message", text: "Continue" });
  store.append("a", tool("first", "completed"));
  store.append("a", { type: "assistant_message", text: "Answer" });
  store.append("a", tool("second", "completed"));
  const tail = store.fetch("a", { limit: 1 });
  expect(tail.rows.map((row) => row.seqStart)).toEqual([1, 2, 3, 5]);
  expect(tail).toMatchObject({ startSeq: 1, endSeq: 6, hasOlder: false });
});

async function measureTimelineTail(wholeTurns: boolean) {
  const fixture = fileURLToPath(
    new URL("./test-utils/timeline-responsiveness.ts", import.meta.url),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    ["--expose-gc", "--import", "tsx", fixture, String(wholeTurns)],
    { timeout: 15_000 },
  );
  process.stderr.write(stderr);
  return JSON.parse(stdout) as {
    result: ReturnType<InMemoryAgentTimelineStore["fetch"]>;
    blockingMs: number;
  };
}

it("excludes unrelated test-runner CPU from the timeline fetch budget", async () => {
  let unrelatedWork: ReturnType<typeof setImmediate>;
  const burnCpu = () => {
    const threadCpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage = Reflect.get(
      process,
      "threadCpuUsage",
    );
    const start = threadCpuUsage();
    let elapsed: NodeJS.CpuUsage;
    do {
      elapsed = threadCpuUsage(start);
    } while (elapsed.user + elapsed.system < 80_000);
    unrelatedWork = setImmediate(burnCpu);
  };
  unrelatedWork = setImmediate(burnCpu);
  try {
    const { result: tail, blockingMs } = await measureTimelineTail(false);
    expect(tail.rows).toHaveLength(200);
    expect(tail.startSeq).toBe(99_801);
    expect(tail.endSeq).toBe(100_000);
    expect(blockingMs).toBeLessThan(50);
  } finally {
    clearImmediate(unrelatedWork);
  }
});

it.each([false, true])(
  "serves tail 200 from 100,000 retained rows without stalling the loop (wholeTurns=%s)",
  async (wholeTurns) => {
    const { result: tail, blockingMs } = await measureTimelineTail(wholeTurns);
    expect(tail.rows).toHaveLength(200);
    expect(tail.startSeq).toBe(99_801);
    expect(tail.endSeq).toBe(100_000);
    expect(blockingMs).toBeLessThan(50);
  },
);

it("matches the previous reprojecting selector on seeded randomized timelines", () => {
  let seed = 0x76aabbcc;
  const random = (bound: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return Math.floor((seed / 0x1_0000_0000) * bound);
  };
  for (let scenario = 0; scenario < 100; scenario++) {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a", { epoch: "e" });
    for (let seq = 1; seq <= 100; seq++) {
      const identity = String(random(8));
      const text = String(seq);
      const items: AgentTimelineItem[] = [
        { type: "user_message", text },
        { type: "assistant_message", text },
        { type: "assistant_message", text, messageId: identity },
        { type: "reasoning", text },
        {
          type: "tool_call",
          callId: identity,
          name: "shell",
          status: "running",
          error: null,
          detail: { type: "plain_text", label: text },
        },
        {
          type: "plugin",
          id: identity,
          pluginId: "test",
          kind: "state",
          version: 1,
          data: { text },
        },
      ];
      store.append("a", items[random(items.length)], { turnId: String(random(3)) });
    }
    // Include rehydration of already-projected rows, with non-monotonic seqEnd.
    store.initialize("b", { rows: store.getRows("a"), epoch: "e" });
    for (const agentId of ["a", "b"]) {
      assertSelectionMatchesReference(store, agentId);
      store.append(agentId, { type: "assistant_message", text: "later" });
      assertSelectionMatchesReference(store, agentId);
    }
  }
});

function assertSelectionMatchesReference(store: InMemoryAgentTimelineStore, agentId: string): void {
  for (const direction of ["tail", "before", "after"] as const) {
    for (const limit of [0, 1, 7, 200]) {
      for (const cursorSeq of [0, 1, 25, 50, 99, 100, 150]) {
        const actual = store.fetch(agentId, {
          direction,
          limit,
          cursor: { epoch: "e", seq: cursorSeq },
        });
        const expected = selectReferenceProjectedTimelinePage({
          rows: store.getRows(agentId),
          bounds: actual.window,
          direction,
          limit,
          cursorSeq,
        });
        expect({
          ...expected,
          entries: undefined,
          rows: expected.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
        }).toEqual({
          entries: undefined,
          rows: actual.rows,
          startSeq: actual.startSeq,
          endSeq: actual.endSeq,
          hasOlder: actual.hasOlder,
          hasNewer: actual.hasNewer,
        });
      }
    }
  }
}

it("continues a scroll across appends and lifecycle collapse without losing source coverage", () => {
  const store = new InMemoryAgentTimelineStore();
  store.initialize("a", { epoch: "e" });
  const tool: AgentTimelineItem = {
    type: "tool_call",
    callId: "t",
    name: "shell",
    status: "running",
    error: null,
    detail: { type: "plain_text", label: "work" },
  };
  store.append("a", tool);
  for (let seq = 2; seq <= 5; seq++) store.append("a", { type: "user_message", text: String(seq) });
  const first = store.fetch("a", { direction: "after", cursor: { epoch: "e", seq: 0 }, limit: 2 });
  expect(first.endSeq).toBe(2);
  store.append("a", { ...tool, status: "completed" });
  store.append("a", { type: "assistant_message", text: "Done" });
  expect(first.rows[0].item).toMatchObject({ status: "running" });
  const second = store.fetch("a", {
    direction: "after",
    cursor: { epoch: "e", seq: first.endSeq! },
    limit: 2,
  });
  expect(second.rows.map((row) => row.seqStart)).toEqual([3, 4]);
  expect(second.endSeq).toBe(4);
  const third = store.fetch("a", {
    direction: "after",
    cursor: { epoch: "e", seq: second.endSeq! },
    limit: 2,
  });
  expect(third.rows.map((row) => row.seqStart)).toEqual([1, 5]);
  expect(third.rows[0].item).toMatchObject({ status: "completed" });
  expect(third.endSeq).toBe(6);
  const last = store.fetch("a", {
    direction: "after",
    cursor: { epoch: "e", seq: third.endSeq! },
    limit: 2,
  });
  expect(last.rows.map((row) => row.item)).toEqual([{ type: "assistant_message", text: "Done" }]);
  expect(last.endSeq).toBe(7);
  expect(last.hasNewer).toBe(false);
});
