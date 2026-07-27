import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  getAssistantBlockSpacing,
  getGapBetweenStreamItems,
  isSameAssistantBlockGroup,
  STREAM_ITEM_GAP,
} from "./spacing";

function assistantBlock(params: {
  id: string;
  blockGroupId: string;
  blockIndex: number;
  text?: string;
}): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id: params.id,
    blockGroupId: params.blockGroupId,
    blockIndex: params.blockIndex,
    text: params.text ?? "",
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function toolCallBlock(id: string): Extract<StreamItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "bash",
        arguments: "cmd",
        result: null,
        status: "executing",
      },
    },
  };
}

function userMessage(id: string): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function thought(id: string): Extract<StreamItem, { kind: "thought" }> {
  return {
    kind: "thought",
    id,
    text: id,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
    status: "ready",
  };
}

describe("isSameAssistantBlockGroup", () => {
  it("returns true for two assistant blocks with the same blockGroupId", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const b = assistantBlock({ id: "b", blockGroupId: "group-1", blockIndex: 1 });
    expect(isSameAssistantBlockGroup({ item: a, other: b })).toBe(true);
  });

  it("returns false for blocks from different groups", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const b = assistantBlock({ id: "b", blockGroupId: "group-2", blockIndex: 0 });
    expect(isSameAssistantBlockGroup({ item: a, other: b })).toBe(false);
  });

  it("returns false when one item is not an assistant_message", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const tc = toolCallBlock("tc-1");
    expect(isSameAssistantBlockGroup({ item: a, other: tc })).toBe(false);
  });

  it("returns false for null neighbors", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    expect(isSameAssistantBlockGroup({ item: a, other: null })).toBe(false);
  });
});

describe("getAssistantBlockSpacing", () => {
  it("returns default for non-assistant items", () => {
    const tc = toolCallBlock("tc-1");
    expect(getAssistantBlockSpacing({ item: tc, aboveItem: null, belowItem: null })).toBe(
      "default",
    );
  });

  it("returns default when no same-group neighbors exist", () => {
    const a = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    expect(getAssistantBlockSpacing({ item: a, aboveItem: null, belowItem: null })).toBe("default");
  });

  it("returns compactTop when the item above is in the same block group", () => {
    const above = assistantBlock({ id: "above", blockGroupId: "group-1", blockIndex: 0 });
    const item = assistantBlock({ id: "item", blockGroupId: "group-1", blockIndex: 1 });
    expect(getAssistantBlockSpacing({ item, aboveItem: above, belowItem: null })).toBe(
      "compactTop",
    );
  });

  it("returns compactBottom when the item below is in the same block group", () => {
    const item = assistantBlock({ id: "item", blockGroupId: "group-1", blockIndex: 0 });
    const below = assistantBlock({ id: "below", blockGroupId: "group-1", blockIndex: 1 });
    expect(getAssistantBlockSpacing({ item, aboveItem: null, belowItem: below })).toBe(
      "compactBottom",
    );
  });

  it("returns compactBoth when both neighbors are in the same block group", () => {
    const above = assistantBlock({ id: "above", blockGroupId: "group-1", blockIndex: 0 });
    const item = assistantBlock({ id: "item", blockGroupId: "group-1", blockIndex: 1 });
    const below = assistantBlock({ id: "below", blockGroupId: "group-1", blockIndex: 2 });
    expect(getAssistantBlockSpacing({ item, aboveItem: above, belowItem: below })).toBe(
      "compactBoth",
    );
  });

  it("spans the history/live-head boundary: tail gets compactBottom, head gets compactTop", () => {
    const tailBlock = assistantBlock({
      id: "group-1:block:0",
      blockGroupId: "group-1",
      blockIndex: 0,
      text: "First paragraph",
    });
    const headBlock = assistantBlock({
      id: "group-1:head",
      blockGroupId: "group-1",
      blockIndex: 1,
      text: "Second paragraph",
    });

    expect(
      getAssistantBlockSpacing({ item: tailBlock, aboveItem: null, belowItem: headBlock }),
    ).toBe("compactBottom");
    expect(
      getAssistantBlockSpacing({ item: headBlock, aboveItem: tailBlock, belowItem: null }),
    ).toBe("compactTop");
  });
});

describe("getGapBetweenStreamItems", () => {
  it("uses the continuous rhythm within dense sequences", () => {
    expect(getGapBetweenStreamItems(userMessage("a"), userMessage("b"))).toBe(
      STREAM_ITEM_GAP.continuous,
    );
    expect(getGapBetweenStreamItems(toolCallBlock("a"), thought("b"))).toBe(
      STREAM_ITEM_GAP.continuous,
    );
  });

  it("uses the related rhythm between process rows and assistant prose", () => {
    const assistant = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    expect(getGapBetweenStreamItems(assistant, toolCallBlock("tool"))).toBe(
      STREAM_ITEM_GAP.related,
    );
    expect(getGapBetweenStreamItems(toolCallBlock("tool"), assistant)).toBe(
      STREAM_ITEM_GAP.related,
    );
  });

  it("uses the continuous rhythm for split blocks in one assistant response", () => {
    const first = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    const second = assistantBlock({ id: "b", blockGroupId: "group-1", blockIndex: 1 });
    expect(getGapBetweenStreamItems(first, second)).toBe(STREAM_ITEM_GAP.continuous);
  });

  it("uses the turn rhythm for unrelated content", () => {
    const assistant = assistantBlock({ id: "a", blockGroupId: "group-1", blockIndex: 0 });
    expect(getGapBetweenStreamItems(userMessage("user"), toolCallBlock("tool"))).toBe(
      STREAM_ITEM_GAP.turn,
    );
    expect(getGapBetweenStreamItems(assistant, userMessage("user"))).toBe(STREAM_ITEM_GAP.turn);
  });

  it("does not add trailing space without a following item", () => {
    expect(getGapBetweenStreamItems(userMessage("user"), null)).toBe(0);
  });
});
