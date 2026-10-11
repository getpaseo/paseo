import { describe, expect, it } from "vitest";
import { contiguousCommittedPrefix, InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
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
    expect(store.append("b", { type: "user_message", text: "next" }).seq).toBe(4);
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
