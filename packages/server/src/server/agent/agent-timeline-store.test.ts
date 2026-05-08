import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("returns a bounded reset window when an after cursor is behind retained history", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    const result = store.fetch("agent-1", {
      direction: "after",
      cursor: { epoch: "epoch-1", seq: 1 },
      limit: 1,
    });

    expect(result).toEqual({
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
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("retains only the newest rows when maxItems is configured", () => {
    const store = new InMemoryAgentTimelineStore({ maxItems: 2 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 8,
      rows: [
        {
          seq: 5,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "five" },
        },
        {
          seq: 6,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });

    expect(store.getRows("agent-1").map((row) => row.seq)).toEqual([6, 7]);
    expect(store.fetch("agent-1", { direction: "tail", limit: 0 }).window).toEqual({
      minSeq: 6,
      maxSeq: 7,
      nextSeq: 8,
    });
  });

  it("keeps timeline storage empty when maxItems is set to zero", () => {
    const store = new InMemoryAgentTimelineStore({ maxItems: 0 });
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 3,
      rows: [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "one" },
        },
        {
          seq: 2,
          timestamp: "2026-01-01T00:00:01.000Z",
          item: { type: "assistant_message", text: "two" },
        },
      ],
    });

    expect(store.getRows("agent-1")).toEqual([]);
    const appended = store.append("agent-1", { type: "assistant_message", text: "three" });
    expect(appended.seq).toBe(3);
    expect(store.getRows("agent-1")).toEqual([]);
    expect(store.fetch("agent-1", { direction: "tail", limit: 0 }).window).toEqual({
      minSeq: 0,
      maxSeq: 0,
      nextSeq: 4,
    });
  });
});
