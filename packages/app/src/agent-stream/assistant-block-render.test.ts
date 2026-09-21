import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { resolveAssistantBlockRender } from "./assistant-block-render";

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function assistantMessage(
  id: string,
  seed: number,
  text: string,
  block?: { groupId: string; index: number },
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text,
    timestamp: timestamp(seed),
    ...(block ? { blockGroupId: block.groupId, blockIndex: block.index } : {}),
  };
}

describe("resolveAssistantBlockRender", () => {
  it("keeps split blocks independent while the turn is streaming", () => {
    const first = assistantMessage("a", 1, "First", { groupId: "turn", index: 0 });
    const second = assistantMessage("b", 2, "Second", { groupId: "turn", index: 1 });
    const aboveById = new Map<string, StreamItem | null>([
      [second.id, first],
      [first.id, null],
    ]);

    expect(
      resolveAssistantBlockRender({
        item: first,
        aboveItem: null,
        belowItem: second,
        phase: "streaming",
        getAboveItem: (id) => aboveById.get(id),
      }),
    ).toEqual({ kind: "text", text: "First" });
    expect(
      resolveAssistantBlockRender({
        item: second,
        aboveItem: first,
        belowItem: null,
        phase: "streaming",
        getAboveItem: (id) => aboveById.get(id),
      }),
    ).toEqual({ kind: "text", text: "Second" });
  });

  it("joins a completed block group onto the newest cell", () => {
    const first = assistantMessage("a", 1, "What is live today.", { groupId: "turn", index: 0 });
    const second = assistantMessage("b", 2, "What I need from you", { groupId: "turn", index: 1 });
    const aboveById = new Map<string, StreamItem | null>([
      [second.id, first],
      [first.id, null],
    ]);

    expect(
      resolveAssistantBlockRender({
        item: first,
        aboveItem: null,
        belowItem: second,
        phase: "complete",
        getAboveItem: (id) => aboveById.get(id),
      }),
    ).toEqual({ kind: "skip" });
    expect(
      resolveAssistantBlockRender({
        item: second,
        aboveItem: first,
        belowItem: null,
        phase: "complete",
        getAboveItem: (id) => aboveById.get(id),
      }),
    ).toEqual({ kind: "text", text: "What is live today.\n\nWhat I need from you" });
  });
});
