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

  it("preserves optional turnId on append and fetch", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", {
      epoch: "epoch-1",
      nextSeq: 1,
      rows: [],
    });

    const withTurn = store.append(
      "agent-1",
      { type: "todo", items: [{ text: "one", completed: false }] },
      { timestamp: "2026-01-01T00:00:00.000Z", turnId: "turn-1" },
    );
    const withoutTurn = store.append(
      "agent-1",
      { type: "assistant_message", text: "done" },
      { timestamp: "2026-01-01T00:00:01.000Z" },
    );

    expect(withTurn.turnId).toBe("turn-1");
    expect(withoutTurn.turnId).toBeUndefined();

    const fetched = store.fetch("agent-1", { direction: "tail", limit: 10 });
    expect(fetched.rows).toEqual([
      {
        seq: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        item: { type: "todo", items: [{ text: "one", completed: false }] },
        turnId: "turn-1",
      },
      {
        seq: 2,
        timestamp: "2026-01-01T00:00:01.000Z",
        item: { type: "assistant_message", text: "done" },
      },
    ]);
  });
});
