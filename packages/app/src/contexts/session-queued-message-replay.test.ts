import { describe, expect, it } from "vitest";
import {
  shouldAutoReplayQueuedAgentMessage,
  takeQueuedAgentMessageReplay,
} from "./session-queued-message-replay";

describe("takeQueuedAgentMessageReplay", () => {
  it("preserves the queued message id for idempotent replay", () => {
    const replay = takeQueuedAgentMessageReplay([
      {
        id: "msg-1",
        text: "resume this",
        images: [
          {
            id: "img-1",
            mimeType: "image/png",
            storageType: "web-indexeddb",
            storageKey: "attachment:img-1",
            fileName: "test.png",
            byteSize: 12,
            createdAt: 1,
          },
        ],
      },
      {
        id: "msg-2",
        text: "second",
      },
    ]);

    expect(replay).toEqual({
      messageId: "msg-1",
      text: "resume this",
      images: [
        {
          id: "img-1",
          mimeType: "image/png",
          storageType: "web-indexeddb",
          storageKey: "attachment:img-1",
          fileName: "test.png",
          byteSize: 12,
          createdAt: 1,
        },
      ],
      remainingQueue: [{ id: "msg-2", text: "second" }],
    });
  });

  it("returns null when the queue is empty", () => {
    expect(takeQueuedAgentMessageReplay([])).toBeNull();
    expect(takeQueuedAgentMessageReplay(undefined)).toBeNull();
  });

  it("only auto-replays queued messages for live running-to-idle transitions", () => {
    expect(
      shouldAutoReplayQueuedAgentMessage({
        previousStatus: "running",
        nextStatus: "idle",
        source: "live",
      }),
    ).toBe(true);

    expect(
      shouldAutoReplayQueuedAgentMessage({
        previousStatus: "running",
        nextStatus: "idle",
        source: "hydrate",
      }),
    ).toBe(false);

    expect(
      shouldAutoReplayQueuedAgentMessage({
        previousStatus: "idle",
        nextStatus: "idle",
        source: "live",
      }),
    ).toBe(false);
  });
});
