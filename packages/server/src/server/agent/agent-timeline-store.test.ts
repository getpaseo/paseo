import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

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
      direction: "before",
      cursor: { epoch: "epoch-1", seq: 100 },
      limit: 2,
    });

    expect(result).toEqual({
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
          item: { type: "assistant_message", text: "six" },
        },
        {
          seq: 7,
          timestamp: "2026-01-01T00:00:02.000Z",
          item: { type: "assistant_message", text: "seven" },
        },
      ],
    });
  });

  it("prepends a chronological range immediately before the loaded range", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 12,
      rows: [
        {
          seq: 10,
          timestamp: "2026-01-01T00:00:10.000Z",
          item: { type: "assistant_message", text: "ten" },
        },
        {
          seq: 11,
          timestamp: "2026-01-01T00:00:11.000Z",
          item: { type: "assistant_message", text: "eleven" },
        },
      ],
    });

    const prepended = store.prepend("agent-1", [
      {
        timestamp: "2026-01-01T00:00:08.000Z",
        item: { type: "assistant_message", text: "eight" },
      },
      {
        timestamp: "2026-01-01T00:00:09.000Z",
        item: { type: "assistant_message", text: "nine" },
      },
    ]);

    expect(prepended.map((row) => row.seq)).toEqual([8, 9]);
    expect(store.getRows("agent-1").map((row) => row.seq)).toEqual([8, 9, 10, 11]);
    expect(
      store.fetch("agent-1", { direction: "before", cursor: { epoch: "epoch-1", seq: 10 } }),
    ).toMatchObject({
      epoch: "epoch-1",
      hasNewer: true,
      rows: [
        { seq: 8, item: { type: "assistant_message", text: "eight" } },
        { seq: 9, item: { type: "assistant_message", text: "nine" } },
      ],
    });
  });

  it("rejects sequence allocation at either safe-integer boundary", () => {
    const store = new InMemoryAgentTimelineStore();
    expect(() =>
      store.initialize("upper", {
        nextSeq: Number.MAX_SAFE_INTEGER,
      }),
    ).toThrow("Timeline sequence allocation exhausted");

    store.initialize("lower", {
      rows: [
        {
          seq: 1,
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "first" },
        },
      ],
      nextSeq: 2,
    });
    expect(() =>
      store.prepend("lower", [
        {
          timestamp: "2026-01-01T00:00:00.000Z",
          item: { type: "assistant_message", text: "before first" },
        },
      ]),
    ).toThrow("Timeline sequence allocation exhausted");
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
});
