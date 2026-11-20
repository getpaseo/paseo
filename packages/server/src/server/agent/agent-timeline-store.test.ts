import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectReferenceProjectedTimelinePage } from "./test-utils/timeline-page-reference.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { contiguousCommittedPrefix, InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
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

describe("bounded in-memory window", () => {
  const userItem = (n: number) =>
    ({ type: "user_message", text: `m${n}`, clientMessageId: `c${n}` }) as const;

  it("evicts oldest rows once the window exceeds the byte cap", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowBytes: 2048 });
    store.initialize("a");
    for (let i = 1; i <= 100; i++) store.append("a", userItem(i));
    store.setDurableWatermark("a", 100);
    store.append("a", userItem(101));

    const rows = store.getCanonicalRows("a");
    expect(rows.length).toBeLessThan(101);
    expect(rows[0]?.seq).toBeGreaterThan(1);
    expect(rows.at(-1)?.seq).toBe(101);
    expect(store.hasEvicted("a")).toBe(true);

    const tail = store.fetch("a", { direction: "tail", limit: 200 });
    expect(tail.rows.at(-1)?.item).toEqual(userItem(101));
    expect(tail.window.minSeq).toBe(tail.rows[0]?.seqStart);
  });

  it("never evicts rows above the durable watermark", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowBytes: 2048 });
    store.initialize("a");
    for (let i = 1; i <= 100; i++) store.append("a", userItem(i));

    expect(store.getCanonicalRows("a")).toHaveLength(100);
    expect(store.hasEvicted("a")).toBe(false);

    store.setDurableWatermark("a", 50);
    store.append("a", userItem(101));

    const rows = store.getCanonicalRows("a");
    expect(rows[0]?.seq).toBe(51);
    expect(rows.at(-1)?.seq).toBe(101);
  });

  it("keeps a merged assistant row that spans the eviction boundary whole", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowBytes: 2048 });
    store.initialize("a");
    for (let i = 1; i <= 20; i++) {
      store.append("a", { type: "assistant_message", text: "x", messageId: "m" });
    }
    for (let i = 21; i <= 60; i++) store.append("a", userItem(i));
    store.setDurableWatermark("a", 10);
    store.append("a", userItem(61));

    const rows = store.getCanonicalRows("a");
    expect(rows[0]?.seq).toBe(11);
    const tail = store.fetch("a", { direction: "tail", limit: 200 });
    expect(tail.rows[0]?.item).toEqual({
      type: "assistant_message",
      text: "x".repeat(20),
      messageId: "m",
    });
    expect(tail.rows[0]?.seqStart).toBe(1);
    expect(tail.rows[0]?.seqEnd).toBe(20);
    expect(tail.window.minSeq).toBe(1);
  });

  it("retains every row when no cap is configured", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a");
    for (let i = 1; i <= 500; i++) store.append("a", userItem(i));
    expect(store.getCanonicalRows("a")).toHaveLength(500);
    expect(store.hasEvicted("a")).toBe(false);
  });

  it("trims a seeded window above the cap once rows are durably confirmed", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowBytes: 2048 });
    const rows = Array.from({ length: 300 }, (_, i) => ({
      seq: i + 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      item: userItem(i + 1),
    }));
    store.initialize("a", { rows });
    expect(store.getCanonicalRows("a")).toHaveLength(300);
    store.setDurableWatermark("a", 300);
    const retained = store.getCanonicalRows("a");
    expect(retained.length).toBeLessThan(300);
    expect(retained.at(-1)?.seq).toBe(300);
    expect(store.hasEvicted("a")).toBe(true);
  });

  it("reports older history for tail pages of an evicted window", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowRows: 4 });
    store.initialize("a");
    for (let i = 1; i <= 20; i++) {
      store.append("a", {
        type: "user_message",
        text: `m${i}`,
        clientMessageId: `c${i}`,
      });
    }
    store.setDurableWatermark("a", 15);
    expect(store.hasEvicted("a")).toBe(true);

    // A tail page larger than the retained window still has durable rows
    // below it; reporting hasOlder=false strands them for good.
    const page = store.fetch("a", { direction: "tail", limit: 50 });
    expect(page.hasOlder).toBe(true);
  });

  it("reports older history for a post-restart window seeded over the durable log", () => {
    // A durable seed leaves the window empty with nextSeq above the committed
    // log. The first new row jumps the window floor past seq 1 without any
    // eviction in this lifetime; the rows below must stay reachable.
    const store = new InMemoryAgentTimelineStore();
    store.initialize("a", { nextSeq: 3, timestamp: "2026-01-01T00:00:00.000Z" });
    store.append("a", userItem(3));

    const page = store.fetch("a", { direction: "tail", limit: 50 });
    expect(page.rows).toHaveLength(1);
    expect(page.hasOlder).toBe(true);
  });

  it("anchors a straddling tool entry's tail page at the retained window floor", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowRows: 7 });
    store.initialize("a");
    const tool = (status: "running" | "completed") => ({
      type: "tool_call" as const,
      callId: "t1",
      name: "shell",
      status,
      error: null,
      detail: { type: "plain_text" as const, label: "work" },
    });
    store.append("a", tool("running"));
    for (let i = 2; i <= 30; i++) store.append("a", userItem(i));
    store.append("a", tool("completed"));
    store.setDurableWatermark("a", 24);
    expect(store.getCanonicalRows("a").map((row) => row.seq)).toEqual([25, 26, 27, 28, 29, 30, 31]);

    // The tool entry straddles the eviction boundary: its anchor (seq 1) must
    // not become the backward cursor, or rows 2..24 are unreachable from the
    // client's older paging.
    const tail = store.fetch("a", { direction: "tail", limit: 200 });
    expect(tail.rows[0]?.seqStart).toBe(1);
    expect(tail.startSeq).toBe(25);
    expect(tail.hasOlder).toBe(true);
    const catchup = store.fetch("a", {
      direction: "after",
      cursor: { epoch: tail.epoch, seq: 10 },
      limit: 200,
    });
    expect(catchup.gap).toBe(true);
    expect(catchup.reset).toBe(true);
    expect(catchup.endSeq).toBe(31);
  });

  it("reports older history when a stale after request resets onto an evicted tail", () => {
    const store = new InMemoryAgentTimelineStore({ maxWindowRows: 4 });
    store.initialize("a");
    for (let i = 1; i <= 20; i++) {
      store.append("a", {
        type: "user_message",
        text: `m${i}`,
        clientMessageId: `c${i}`,
      });
    }
    store.setDurableWatermark("a", 16);
    expect(store.hasEvicted("a")).toBe(true);

    // An after request with a stale epoch resets onto a tail page; the
    // evicted rows below the page must stay reachable through hasOlder.
    const page = store.fetch("a", {
      direction: "after",
      cursor: { epoch: "stale-epoch", seq: 5 },
      limit: 50,
    });
    expect(page.reset).toBe(true);
    expect(page.rows.map((row) => row.seq)).toEqual([17, 18, 19, 20]);
    expect(page.hasOlder).toBe(true);
  });
});

describe("contiguousCommittedPrefix", () => {
  it("returns zero for an empty log", () => {
    expect(contiguousCommittedPrefix([])).toBe(0);
  });

  it("returns the highest seq when every seq from one is present", () => {
    expect(contiguousCommittedPrefix([1, 2, 3])).toBe(3);
  });

  it("returns zero when the leading seq is missing", () => {
    expect(contiguousCommittedPrefix([2, 3, 4])).toBe(0);
  });

  it("stops at a gap in the middle", () => {
    expect(contiguousCommittedPrefix([1, 2, 4, 5])).toBe(2);
  });

  it("ignores row order and duplicate seqs", () => {
    expect(contiguousCommittedPrefix([2, 1, 4, 3, 1])).toBe(4);
  });
});
