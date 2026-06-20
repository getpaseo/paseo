import { describe, expect, it } from "vitest";
import type { StreamItem } from "@/types/stream";
import { buildCollapseThinkingGroups } from "./collapse-thinking";
import { orderHeadForStreamRenderStrategy, orderTailForStreamRenderStrategy } from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";

function buildCompletedThinkingGroups(items: readonly StreamItem[]) {
  return buildCollapseThinkingGroups({ items, behavior: "completed" });
}

function timestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): StreamItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: timestamp(seed),
  };
}

function assistantMessage(id: string, seed: number): StreamItem {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: timestamp(seed),
  };
}

function thought(id: string, seed: number): StreamItem {
  return {
    kind: "thought",
    id,
    text: id,
    timestamp: timestamp(seed),
    status: "ready",
  };
}

function toolCall(id: string, seed: number): StreamItem {
  return {
    kind: "tool_call",
    id,
    timestamp: timestamp(seed),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "Shell",
        arguments: "echo hi",
        result: null,
        status: "completed",
      },
    },
  };
}

function groupItemIds(items: StreamItem[]): string[][] {
  return buildCompletedThinkingGroups(items).groups.map((group) => group.itemIds);
}

describe("buildCollapseThinkingGroups", () => {
  it("groups reasoning and tool calls while leaving the final assistant outside", () => {
    const index = buildCompletedThinkingGroups([
      userMessage("u1", 1),
      thought("t1", 2),
      toolCall("tool-1", 3),
      assistantMessage("a1", 4),
    ]);

    expect(index.groups).toHaveLength(1);
    expect(index.groups[0]).toMatchObject({
      anchorItemId: "t1",
      itemIds: ["t1", "tool-1"],
      defaultExpanded: false,
      status: "completed",
      finalAssistantItemId: "a1",
    });
    expect(index.groupByItemId.has("a1")).toBe(false);
  });

  it("groups intermediate assistant text and leaves the last assistant visible", () => {
    const index = buildCompletedThinkingGroups([
      userMessage("u1", 1),
      assistantMessage("a1", 2),
      thought("t1", 3),
      assistantMessage("a2", 4),
    ]);

    expect(index.groups[0]?.itemIds).toEqual(["a1", "t1"]);
    expect(index.groupByItemId.has("a2")).toBe(false);
  });

  it("keeps an active turn with no assistant candidate expanded", () => {
    const index = buildCompletedThinkingGroups([
      userMessage("u1", 1),
      thought("t1", 2),
      toolCall("tool-1", 3),
    ]);

    expect(index.groups[0]).toMatchObject({
      itemIds: ["t1", "tool-1"],
      defaultExpanded: true,
      status: "active",
      finalAssistantItemId: null,
    });
  });

  it("collapses an active turn by default in completed-and-active mode", () => {
    const index = buildCollapseThinkingGroups({
      behavior: "completed-and-active",
      items: [userMessage("u1", 1), thought("t1", 2), toolCall("tool-1", 3)],
    });

    expect(index.groups[0]).toMatchObject({
      itemIds: ["t1", "tool-1"],
      defaultExpanded: false,
      status: "active",
    });
  });

  it("auto-collapses once an assistant candidate appears", () => {
    const beforeAssistant = buildCompletedThinkingGroups([userMessage("u1", 1), thought("t1", 2)]);
    const afterAssistant = buildCompletedThinkingGroups([
      userMessage("u1", 1),
      thought("t1", 2),
      assistantMessage("a1", 3),
    ]);

    expect(beforeAssistant.groups[0]?.defaultExpanded).toBe(true);
    expect(beforeAssistant.groups[0]?.id).toBe("thinking:u1:active");
    expect(afterAssistant.groups[0]?.defaultExpanded).toBe(false);
    expect(afterAssistant.groups[0]?.id).toBe("thinking:u1:final");
  });

  it("handles multiple turns independently", () => {
    const index = buildCompletedThinkingGroups([
      userMessage("u1", 1),
      thought("t1", 2),
      assistantMessage("a1", 3),
      userMessage("u2", 4),
      toolCall("tool-1", 5),
      assistantMessage("a2", 6),
    ]);

    expect(index.groups.map((group) => group.id)).toEqual([
      "thinking:u1:final",
      "thinking:u2:final",
    ]);
    expect(index.groups.map((group) => group.itemIds)).toEqual([["t1"], ["tool-1"]]);
  });

  it("produces the same groups before web and native render ordering", () => {
    const tail = [userMessage("u1", 1), toolCall("tool-1", 2)];
    const head = [thought("t1", 3), assistantMessage("a1", 4)];
    const chronological = [...tail, ...head];
    const web = resolveStreamRenderStrategy({ platform: "web", isMobileBreakpoint: false });
    const native = resolveStreamRenderStrategy({ platform: "android", isMobileBreakpoint: false });

    expect(groupItemIds(chronological)).toEqual([["tool-1", "t1"]]);
    expect(
      orderTailForStreamRenderStrategy({ strategy: web, streamItems: tail }).map((item) => item.id),
    ).toEqual(["u1", "tool-1"]);
    expect(
      orderTailForStreamRenderStrategy({ strategy: native, streamItems: tail }).map(
        (item) => item.id,
      ),
    ).toEqual(["tool-1", "u1"]);
    expect(
      orderHeadForStreamRenderStrategy({ strategy: native, streamHead: head }).map(
        (item) => item.id,
      ),
    ).toEqual(["a1", "t1"]);
  });
});
