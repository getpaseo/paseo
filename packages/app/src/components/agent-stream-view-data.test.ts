import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { NeighborResolver } from "./agent-stream-view-data";
import {
  getAssistantBlockSpacing,
  isSameAssistantBlockGroup,
  resolveInlineWorkingIndicatorItemId,
} from "./agent-stream-view-data";

// Minimal forward-order resolver: "below" = next item in array.
// Matches web strategy rendering order (chronological, top-to-bottom).
const forwardStrategy: NeighborResolver = {
  getNeighborItem(items, index, relation) {
    const neighborIndex = relation === "below" ? index + 1 : index - 1;
    return items[neighborIndex];
  },
};

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

describe("resolveInlineWorkingIndicatorItemId", () => {
  it("returns null when the agent is not running", () => {
    const head = assistantBlock({ id: "head", blockGroupId: "group-1", blockIndex: 0 });
    expect(resolveInlineWorkingIndicatorItemId("idle", [head], forwardStrategy)).toBeNull();
  });

  it("returns the last assistant block id when running with a single head block", () => {
    const head = assistantBlock({ id: "group-1:head", blockGroupId: "group-1", blockIndex: 0 });
    expect(resolveInlineWorkingIndicatorItemId("running", [head], forwardStrategy)).toBe(
      "group-1:head",
    );
  });

  it("returns null when live head contains only a tool call (uses auxiliary indicator instead)", () => {
    const tc = toolCallBlock("tool-1");
    expect(resolveInlineWorkingIndicatorItemId("running", [tc], forwardStrategy)).toBeNull();
  });

  it("returns the footer assistant block when history and streaming head coexist", () => {
    const historyBlock = assistantBlock({
      id: "group-1:block:0",
      blockGroupId: "group-1",
      blockIndex: 0,
    });
    const streamingBlock = assistantBlock({
      id: "group-2:head",
      blockGroupId: "group-2",
      blockIndex: 0,
    });
    // historyBlock is in streamItems (tail), not liveHead — liveHead holds only the streaming block
    expect(resolveInlineWorkingIndicatorItemId("running", [streamingBlock], forwardStrategy)).toBe(
      "group-2:head",
    );
    expect(
      resolveInlineWorkingIndicatorItemId(
        "running",
        [historyBlock, streamingBlock],
        forwardStrategy,
      ),
    ).toBe("group-2:head");
  });
});
