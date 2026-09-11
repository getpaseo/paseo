import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolvePinnedPrompt } from "./model";

function userMessage(id: string, text: string): StreamItem {
  return { kind: "user_message", id, text, timestamp: new Date(0) };
}

function assistantMessage(id: string): StreamItem {
  return { kind: "assistant_message", id, text: `reply ${id}`, timestamp: new Date(0) };
}

const items: StreamItem[] = [
  userMessage("p1", "first prompt"),
  assistantMessage("a1"),
  assistantMessage("a2"),
  userMessage("p2", "second prompt"),
  assistantMessage("a3"),
];

describe("resolvePinnedPrompt", () => {
  it("pins the prompt that started the turn the reader is inside", () => {
    expect(resolvePinnedPrompt({ items, readingRowId: "a1" })).toEqual({
      id: "p1",
      text: "first prompt",
    });
    expect(resolvePinnedPrompt({ items, readingRowId: "a2" })).toEqual({
      id: "p1",
      text: "first prompt",
    });
    expect(resolvePinnedPrompt({ items, readingRowId: "a3" })).toEqual({
      id: "p2",
      text: "second prompt",
    });
  });

  it("pins nothing while the prompt's own bubble is the reading row", () => {
    expect(resolvePinnedPrompt({ items, readingRowId: "p1" })).toBeNull();
    expect(resolvePinnedPrompt({ items, readingRowId: "p2" })).toBeNull();
  });

  it("pins nothing without a reading row, or for a row outside the window", () => {
    expect(resolvePinnedPrompt({ items, readingRowId: null })).toBeNull();
    expect(resolvePinnedPrompt({ items, readingRowId: "gone" })).toBeNull();
    expect(resolvePinnedPrompt({ items: [], readingRowId: "a1" })).toBeNull();
  });

  it("pins nothing when the window opens mid-turn with no preceding prompt", () => {
    const midTurn = [assistantMessage("a1"), assistantMessage("a2")];

    expect(resolvePinnedPrompt({ items: midTurn, readingRowId: "a2" })).toBeNull();
  });

  it("pins nothing for an attachment-only prompt that has no text", () => {
    const imagesOnly = [userMessage("p1", "   "), assistantMessage("a1")];

    expect(resolvePinnedPrompt({ items: imagesOnly, readingRowId: "a1" })).toBeNull();
  });

  it("pins a prompt in loaded history while the reader is in the live head", () => {
    const history = [userMessage("p1", "first prompt"), assistantMessage("a1")];
    const liveHead = [assistantMessage("live-1")];

    expect(
      resolvePinnedPrompt({ items: [...history, ...liveHead], readingRowId: "live-1" }),
    ).toEqual({ id: "p1", text: "first prompt" });
  });
});
