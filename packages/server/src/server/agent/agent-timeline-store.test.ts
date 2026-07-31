import { describe, expect, it } from "vitest";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";

describe("InMemoryAgentTimelineStore", () => {
  it("enriches a submitted prompt without allocating a second sequence", () => {
    const store = new InMemoryAgentTimelineStore();
    store.initialize("agent-1", { epoch: "epoch-1" });
    store.append("agent-1", {
      type: "user_message",
      text: "Accepted prompt",
      clientMessageId: "client-message-1",
    });

    const updated = store.enrichSubmittedUserMessage("agent-1", "client-message-1", {
      messageId: "provider-message-1",
    });

    expect(updated).toMatchObject({
      seq: 1,
      item: {
        type: "user_message",
        text: "Accepted prompt",
        clientMessageId: "client-message-1",
        messageId: "provider-message-1",
      },
    });
    expect(store.getRows("agent-1")).toEqual([updated]);
    expect(store.fetch("agent-1", { direction: "tail", limit: 1 }).window).toEqual({
      minSeq: 1,
      maxSeq: 1,
      nextSeq: 2,
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
