import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolveAssistantTurnBoundaryMessageId } from "./turn-boundary";

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

describe("resolveAssistantTurnBoundaryMessageId", () => {
  it("uses the selected assistant message id", () => {
    const selected = assistantMessage("assistant-1", 2, "msg-assistant-1");

    expect(
      resolveAssistantTurnBoundaryMessageId({
        items: [userMessage("user-1", 1), selected],
        startIndex: 1,
      }),
    ).toBe("msg-assistant-1");
  });

  it("does not borrow a boundary id from another assistant in the same turn", () => {
    const first = assistantMessage("assistant-1", 2, "msg-assistant-1");
    const selected = assistantMessage("assistant-2", 3);

    expect(
      resolveAssistantTurnBoundaryMessageId({
        items: [userMessage("user-1", 1), first, selected],
        startIndex: 2,
      }),
    ).toBeUndefined();
  });

  it("requires the selected item to be an assistant message", () => {
    expect(
      resolveAssistantTurnBoundaryMessageId({
        items: [userMessage("user-1", 1), assistantMessage("assistant-1", 2, "msg-assistant-1")],
        startIndex: 0,
      }),
    ).toBeUndefined();
  });
});
