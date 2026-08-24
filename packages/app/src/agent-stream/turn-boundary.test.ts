import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolveAssistantTurnForkBoundary } from "./turn-boundary";

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: timestamp(seed),
  };
}

function assistantMessage(
  id: string,
  seed: number,
  messageId?: string,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: timestamp(seed),
    ...(messageId ? { messageId } : {}),
  };
}

describe("resolveAssistantTurnForkBoundary", () => {
  it("forks a failed assistant turn from its Paseo timeline cursor without a provider message id", () => {
    const failedTurn = {
      ...assistantMessage("assistant-error", 2),
      timelineCursor: { epoch: "timeline-1", seq: 42 },
    };

    expect(
      resolveAssistantTurnForkBoundary({
        items: [userMessage("user-1", 1), failedTurn],
        startIndex: 1,
        supportsTimelineCursor: true,
      }),
    ).toEqual({
      boundaryCursor: { epoch: "timeline-1", seq: 42 },
    });
  });

  it("includes the provider message id with a supported timeline cursor", () => {
    const selected = {
      ...assistantMessage("assistant-1", 2, "msg-assistant-1"),
      timelineCursor: { epoch: "timeline-1", seq: 42 },
    };

    expect(
      resolveAssistantTurnForkBoundary({
        items: [selected],
        startIndex: 0,
        supportsTimelineCursor: true,
      }),
    ).toEqual({
      boundaryCursor: { epoch: "timeline-1", seq: 42 },
      boundaryMessageId: "msg-assistant-1",
    });
  });

  it("falls back to the provider message id when timeline cursors are unsupported", () => {
    const selected = {
      ...assistantMessage("assistant-1", 2, "msg-assistant-1"),
      timelineCursor: { epoch: "timeline-1", seq: 42 },
    };

    expect(
      resolveAssistantTurnForkBoundary({
        items: [selected],
        startIndex: 0,
        supportsTimelineCursor: false,
      }),
    ).toEqual({ boundaryMessageId: "msg-assistant-1" });
  });

  it("does not borrow a provider message id from another assistant in the same turn", () => {
    const first = assistantMessage("assistant-1", 2, "msg-assistant-1");
    const selected = assistantMessage("assistant-2", 3);

    expect(
      resolveAssistantTurnForkBoundary({
        items: [userMessage("user-1", 1), first, selected],
        startIndex: 2,
        supportsTimelineCursor: false,
      }),
    ).toBeUndefined();
  });

  it("requires the selected item to be an assistant message", () => {
    expect(
      resolveAssistantTurnForkBoundary({
        items: [userMessage("user-1", 1), assistantMessage("assistant-1", 2, "msg-assistant-1")],
        startIndex: 0,
        supportsTimelineCursor: false,
      }),
    ).toBeUndefined();
  });

  it("does not offer an unavailable boundary", () => {
    expect(
      resolveAssistantTurnForkBoundary({
        items: [assistantMessage("assistant-1", 2)],
        startIndex: 0,
        supportsTimelineCursor: false,
      }),
    ).toBeUndefined();
  });
});
