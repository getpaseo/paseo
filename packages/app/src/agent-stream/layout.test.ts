import { describe, expect, it } from "vitest";
import type { TurnTiming } from "@/timeline/turn-time";
import type { StreamItem } from "@/types/stream";
import {
  orderHeadForStreamRenderStrategy,
  orderTailForStreamRenderStrategy,
  type StreamStrategy,
} from "./strategy";
import { resolveStreamRenderStrategy } from "./strategy-resolver";
import { layoutStream, type StreamLayout, type StreamLayoutItem } from "./layout";

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
  block?: { groupId: string; index: number },
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: timestamp(seed),
    ...(block ? { blockGroupId: block.groupId, blockIndex: block.index } : {}),
  };
}

function toolCall(id: string, seed: number): Extract<StreamItem, { kind: "tool_call" }> {
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

function thought(id: string, seed: number): Extract<StreamItem, { kind: "thought" }> {
  return {
    kind: "thought",
    id,
    text: id,
    timestamp: timestamp(seed),
    status: "ready",
  };
}

function timingFor(...ids: string[]): Map<string, TurnTiming> {
  const timing = {
    startedAt: timestamp(1),
    completedAt: timestamp(9),
    durationMs: 8000,
  };
  return new Map(ids.map((id) => [id, timing]));
}

function strategyFor(platform: "web" | "android"): StreamStrategy {
  return resolveStreamRenderStrategy({
    platform,
    isMobileBreakpoint: false,
  });
}

function layoutFor(input: {
  platform: "web" | "android";
  agentStatus?: string;
  tail: StreamItem[];
  head?: StreamItem[];
  timingIds?: string[];
}): StreamLayout {
  const strategy = strategyFor(input.platform);
  return layoutStream({
    strategy,
    agentStatus: input.agentStatus ?? "idle",
    history: orderTailForStreamRenderStrategy({
      strategy,
      streamItems: input.tail,
    }),
    liveHead: orderHeadForStreamRenderStrategy({
      strategy,
      streamHead: input.head ?? [],
    }),
    timingByAssistantId: timingFor(...(input.timingIds ?? [])),
  });
}

function footerOwners(layout: StreamLayout): string[] {
  const owners = [
    ...layout.history.flatMap((item) => (item.completedFooter ? [item.item.id] : [])),
    ...layout.liveHead.flatMap((item) => (item.completedFooter ? [item.item.id] : [])),
    ...(layout.auxiliaryTurnFooter ? [layout.auxiliaryTurnFooter.itemId] : []),
  ];
  return owners;
}

function footerAssistantIds(layout: StreamLayout): string[] {
  return [
    ...layout.history.flatMap((item) =>
      item.completedFooter ? [item.completedFooter.itemId] : [],
    ),
    ...layout.liveHead.flatMap((item) =>
      item.completedFooter ? [item.completedFooter.itemId] : [],
    ),
    ...(layout.auxiliaryTurnFooter ? [layout.auxiliaryTurnFooter.itemId] : []),
  ];
}

function inlineFooterPlacementByItemId(layout: StreamLayout): Record<string, string> {
  return Object.fromEntries(
    [...layout.history, ...layout.liveHead].flatMap((item) =>
      item.completedFooter ? [[item.item.id, item.completedFooter.itemId]] : [],
    ),
  );
}

function findLayoutItem(layout: StreamLayout, id: string): StreamLayoutItem {
  const item = [...layout.history, ...layout.liveHead].find(
    (candidate) => candidate.item.id === id,
  );
  if (!item) {
    throw new Error(`Missing layout item ${id}`);
  }
  return item;
}

describe("layoutStream", () => {
  it.each(["web", "android"] as const)(
    "keeps split assistant block spacing identical to unsplit history on %s",
    (platform) => {
      const firstBlock = assistantMessage("turn:block:0", 2, { groupId: "turn", index: 0 });
      const secondBlock = assistantMessage("turn:block:1", 3, { groupId: "turn", index: 1 });
      const thirdBlock = assistantMessage("turn:block:2", 4, { groupId: "turn", index: 2 });
      const splitLayout = layoutFor({
        platform,
        agentStatus: "running",
        tail: [userMessage("u1", 1), firstBlock],
        head: [secondBlock, thirdBlock],
        timingIds: [firstBlock.id, secondBlock.id, thirdBlock.id],
      });
      const unsplitLayout = layoutFor({
        platform,
        agentStatus: "running",
        tail: [userMessage("u1", 1), firstBlock, secondBlock, thirdBlock],
        timingIds: [firstBlock.id, secondBlock.id, thirdBlock.id],
      });

      expect(findLayoutItem(splitLayout, firstBlock.id).belowItem?.id).toBe(secondBlock.id);
      expect(findLayoutItem(splitLayout, secondBlock.id).aboveItem?.id).toBe(firstBlock.id);
      expect(findLayoutItem(splitLayout, firstBlock.id).assistantSpacing).toBe(
        findLayoutItem(unsplitLayout, firstBlock.id).assistantSpacing,
      );
      expect(findLayoutItem(splitLayout, secondBlock.id).assistantSpacing).toBe(
        findLayoutItem(unsplitLayout, secondBlock.id).assistantSpacing,
      );
      expect(findLayoutItem(splitLayout, firstBlock.id).gapBelow).toBe(
        findLayoutItem(unsplitLayout, firstBlock.id).gapBelow,
      );
      expect(findLayoutItem(splitLayout, secondBlock.id).gapBelow).toBe(
        findLayoutItem(unsplitLayout, secondBlock.id).gapBelow,
      );
    },
  );

  it("does not duplicate footers when a native assistant turn spans history and live head", () => {
    const historyBlock = assistantMessage("turn:block:0", 2, { groupId: "turn", index: 0 });
    const headBlock = assistantMessage("turn:head", 3, { groupId: "turn", index: 1 });
    const layout = layoutFor({
      platform: "android",
      tail: [userMessage("u1", 1), historyBlock],
      head: [headBlock],
      timingIds: [historyBlock.id, headBlock.id],
    });

    expect(footerOwners(layout)).toEqual([headBlock.id]);
    expect(findLayoutItem(layout, historyBlock.id).belowItem?.id).toBe(headBlock.id);
    expect(findLayoutItem(layout, historyBlock.id).completedFooter).toBeNull();
  });

  it("does not duplicate footers when a web assistant turn spans history and live head", () => {
    const historyBlock = assistantMessage("turn:block:0", 2, { groupId: "turn", index: 0 });
    const headBlock = assistantMessage("turn:head", 3, { groupId: "turn", index: 1 });
    const layout = layoutFor({
      platform: "web",
      tail: [userMessage("u1", 1), historyBlock],
      head: [headBlock],
      timingIds: [historyBlock.id, headBlock.id],
    });

    expect(footerOwners(layout)).toEqual([headBlock.id]);
    expect(findLayoutItem(layout, historyBlock.id).belowItem?.id).toBe(headBlock.id);
    expect(findLayoutItem(layout, headBlock.id).aboveItem?.id).toBe(historyBlock.id);
  });

  it("keeps the completed footer visually after the assistant after a native user reply", () => {
    const assistant = assistantMessage("a1", 2);
    const layout = layoutFor({
      platform: "android",
      tail: [userMessage("u1", 1), assistant, userMessage("u2", 3)],
      timingIds: [assistant.id],
    });
    const assistantRow = findLayoutItem(layout, assistant.id);

    expect(layout.auxiliaryTurnFooter).toBeNull();
    expect(assistantRow.completedFooter?.itemId).toBe(assistant.id);
    expect(assistantRow.belowItem?.id).toBe("u2");
    expect(assistantRow.frameOrder).toBe("footer-then-content");
  });

  it("keeps forward stream content before its completed footer", () => {
    const assistant = assistantMessage("a1", 2);
    const layout = layoutFor({
      platform: "web",
      tail: [userMessage("u1", 1), assistant, userMessage("u2", 3)],
      timingIds: [assistant.id],
    });
    const assistantRow = findLayoutItem(layout, assistant.id);

    expect(assistantRow.completedFooter?.itemId).toBe(assistant.id);
    expect(assistantRow.frameOrder).toBe("content-then-footer");
  });

  it("compacts assistant block spacing across the history and live-head boundary", () => {
    const historyBlock = assistantMessage("turn:block:0", 2, { groupId: "turn", index: 0 });
    const headBlock = assistantMessage("turn:head", 3, { groupId: "turn", index: 1 });
    const layout = layoutFor({
      platform: "android",
      tail: [userMessage("u1", 1), historyBlock],
      head: [headBlock],
      timingIds: [historyBlock.id, headBlock.id],
    });

    expect(findLayoutItem(layout, historyBlock.id).assistantSpacing).toBe("compactBottom");
    expect(findLayoutItem(layout, headBlock.id).assistantSpacing).toBe("compactTop");
  });

  it.each(["web", "android"] as const)(
    "keeps split tool sequencing and gapBelow identical to unsplit history on %s",
    (platform) => {
      const shell = toolCall("tool-1", 2);
      const thinking = thought("thought-1", 3);
      const assistant = assistantMessage("a1", 4);
      const splitLayout = layoutFor({
        platform,
        tail: [userMessage("u1", 1), shell],
        head: [thinking, assistant],
      });
      const unsplitLayout = layoutFor({
        platform,
        tail: [userMessage("u1", 1), shell, thinking, assistant],
      });

      expect(findLayoutItem(splitLayout, shell.id).belowItem?.id).toBe(thinking.id);
      expect(findLayoutItem(splitLayout, thinking.id).aboveItem?.id).toBe(shell.id);
      expect(findLayoutItem(splitLayout, shell.id).toolSequence).toBe(
        findLayoutItem(unsplitLayout, shell.id).toolSequence,
      );
      expect(findLayoutItem(splitLayout, thinking.id).toolSequence).toBe(
        findLayoutItem(unsplitLayout, thinking.id).toolSequence,
      );
      expect(findLayoutItem(splitLayout, shell.id).gapBelow).toBe(
        findLayoutItem(unsplitLayout, shell.id).gapBelow,
      );
      expect(findLayoutItem(splitLayout, thinking.id).gapBelow).toBe(
        findLayoutItem(unsplitLayout, thinking.id).gapBelow,
      );
    },
  );

  it("computes tool sequence position from strategy-aware neighbors", () => {
    const shell = toolCall("tool-1", 2);
    const thinking = thought("thought-1", 3);
    const layout = layoutFor({
      platform: "android",
      tail: [userMessage("u1", 1), shell, thinking, assistantMessage("a1", 4)],
    });

    expect(findLayoutItem(layout, shell.id).toolSequence).toBe("first");
    expect(findLayoutItem(layout, thinking.id).toolSequence).toBe("last");
  });

  it("keeps bottom and inline footer ownership mutually exclusive", () => {
    const assistant = assistantMessage("a1", 2);
    const layout = layoutFor({
      platform: "web",
      tail: [userMessage("u1", 1), assistant],
      timingIds: [assistant.id],
    });

    expect(layout.auxiliaryTurnFooter?.itemId).toBe(assistant.id);
    expect(findLayoutItem(layout, assistant.id).completedFooter).toBeNull();
    expect(footerOwners(layout)).toEqual([assistant.id]);
  });

  it.each(["web", "android"] as const)(
    "places inline footer after trailing visible tool rows before the next user on %s",
    (platform) => {
      const assistant = assistantMessage("a1", 2);
      const tool = toolCall("tool-1", 3);
      const layout = layoutFor({
        platform,
        tail: [userMessage("u1", 1), assistant, tool, userMessage("u2", 4)],
        timingIds: [assistant.id],
      });

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(findLayoutItem(layout, assistant.id).completedFooter).toBeNull();
      expect(findLayoutItem(layout, tool.id).completedFooter?.itemId).toBe(assistant.id);
      expect(footerOwners(layout)).toEqual([tool.id]);
      expect(footerAssistantIds(layout)).toEqual([assistant.id]);
    },
  );

  it.each(["web", "android"] as const)(
    "places split live-head tool footer using the assistant from history on %s",
    (platform) => {
      const assistant = assistantMessage("a1", 2);
      const tool = toolCall("tool-1", 3);
      const layout = layoutFor({
        platform,
        tail: [userMessage("u1", 1), assistant],
        head: [tool, userMessage("u2", 4)],
        timingIds: [assistant.id],
      });

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(findLayoutItem(layout, assistant.id).completedFooter).toBeNull();
      expect(findLayoutItem(layout, tool.id).completedFooter?.itemId).toBe(assistant.id);
      expect(inlineFooterPlacementByItemId(layout)).toEqual({
        [tool.id]: assistant.id,
      });
    },
  );

  it.each(["web", "android"] as const)(
    "uses the latest assistant for footer content while placing after the visible turn end on %s",
    (platform) => {
      const firstAssistant = assistantMessage("a1", 2);
      const firstTool = toolCall("tool-1", 3);
      const latestAssistant = assistantMessage("a2", 4);
      const latestTool = toolCall("tool-2", 5);
      const layout = layoutFor({
        platform,
        tail: [
          userMessage("u1", 1),
          firstAssistant,
          firstTool,
          latestAssistant,
          latestTool,
          userMessage("u2", 6),
        ],
        timingIds: [firstAssistant.id, latestAssistant.id],
      });

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(findLayoutItem(layout, firstAssistant.id).completedFooter).toBeNull();
      expect(findLayoutItem(layout, latestAssistant.id).completedFooter).toBeNull();
      expect(findLayoutItem(layout, latestTool.id).completedFooter?.itemId).toBe(
        latestAssistant.id,
      );
      expect(footerOwners(layout)).toEqual([latestTool.id]);
      expect(footerAssistantIds(layout)).toEqual([latestAssistant.id]);
    },
  );

  it.each(["web", "android"] as const)(
    "keeps every completed turn footer while placing each one after that turn's last visible item on %s",
    (platform) => {
      const firstAssistant = assistantMessage("a1", 2);
      const secondAssistant = assistantMessage("a2", 4);
      const secondTool = toolCall("tool-2", 5);
      const layout = layoutFor({
        platform,
        tail: [
          userMessage("u1", 1),
          firstAssistant,
          userMessage("u2", 3),
          secondAssistant,
          secondTool,
          userMessage("u3", 6),
        ],
        timingIds: [firstAssistant.id, secondAssistant.id],
      });

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(findLayoutItem(layout, firstAssistant.id).completedFooter?.itemId).toBe(
        firstAssistant.id,
      );
      expect(findLayoutItem(layout, secondAssistant.id).completedFooter).toBeNull();
      expect(findLayoutItem(layout, secondTool.id).completedFooter?.itemId).toBe(
        secondAssistant.id,
      );
      expect(inlineFooterPlacementByItemId(layout)).toEqual({
        [firstAssistant.id]: firstAssistant.id,
        [secondTool.id]: secondAssistant.id,
      });
    },
  );

  it.each(["web", "android"] as const)(
    "keeps bottom footer on the latest assistant turn when trailing tool rows end the turn on %s",
    (platform) => {
      const assistant = assistantMessage("a1", 2);
      const tool = toolCall("tool-1", 3);
      const layout = layoutFor({
        platform,
        tail: [userMessage("u1", 1), assistant, tool],
        timingIds: [assistant.id],
      });

      expect(layout.auxiliaryTurnFooter?.itemId).toBe(assistant.id);
      expect(findLayoutItem(layout, assistant.id).completedFooter).toBeNull();
      expect(footerOwners(layout)).toEqual([assistant.id]);
    },
  );

  it.each(["web", "android"] as const)(
    "does not render a completed footer before tool rows while the turn is running on %s",
    (platform) => {
      const assistant = assistantMessage("a1", 2);
      const tool = toolCall("tool-1", 3);
      const layout = layoutFor({
        platform,
        agentStatus: "running",
        tail: [userMessage("u1", 1), assistant, tool],
        timingIds: [assistant.id],
      });

      expect(layout.auxiliaryTurnFooter).toBeNull();
      expect(findLayoutItem(layout, assistant.id).completedFooter).toBeNull();
      expect(footerOwners(layout)).toEqual([]);
    },
  );
});
