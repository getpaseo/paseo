import { describe, expect, it } from "vitest";
import {
  getAssistantMessageSpacing,
  getGapBetweenStreamItems,
  isToolSequenceItem,
} from "./spacing";
import type { StreamItem } from "@/types/stream";
import { SPACING } from "@/styles/theme";

const message: StreamItem = {
  kind: "assistant_message",
  id: "m",
  text: "First\n\nSecond",
  timestamp: new Date(0),
};
describe("whole-message spacing", () => {
  it("compacts only the gap to its turn footer", () => {
    expect(getAssistantMessageSpacing({ item: message })).toBe("default");
    expect(getAssistantMessageSpacing({ item: message, hasFooterBelow: true })).toBe(
      "compactBottom",
    );
  });
  it("keeps separate messages separated", () => {
    expect(getGapBetweenStreamItems(message, { ...message, id: "next" })).toBeGreaterThan(0);
  });
});

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

function pluginItem(
  id: string,
  sourceKind?: Extract<StreamItem, { kind: "plugin" }>["sourceKind"],
): Extract<StreamItem, { kind: "plugin" }> {
  return {
    kind: "plugin",
    id,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
    pluginId: "tools",
    pluginItemId: id,
    itemKind: "tool",
    version: 1,
    data: null,
    ...(sourceKind ? { sourceKind } : {}),
  };
}

function userMessage(id: string): Extract<StreamItem, { kind: "user_message" }> {
  return { kind: "user_message", id, text: id, timestamp: new Date("2026-05-01T00:00:00.000Z") };
}

describe("tool sequence spacing for plugin items", () => {
  it.each(["tool_call", "thought", "todo_list"] as const)(
    "treats a plugin item projected from %s as part of the tool sequence",
    (sourceKind) => {
      expect(isToolSequenceItem(pluginItem("p", sourceKind))).toBe(true);
    },
  );

  it.each(["assistant_message", "user_message", "notification", "compaction"] as const)(
    "does not treat a plugin item projected from %s as part of the tool sequence",
    (sourceKind) => {
      expect(isToolSequenceItem(pluginItem("p", sourceKind))).toBe(false);
    },
  );

  it("does not treat a plugin item without a source kind as part of the tool sequence", () => {
    expect(isToolSequenceItem(pluginItem("p"))).toBe(false);
  });

  it("stacks consecutive plugin tool rows with no gap", () => {
    expect(
      getGapBetweenStreamItems(pluginItem("a", "tool_call"), pluginItem("b", "tool_call")),
    ).toBe(0);
    expect(getGapBetweenStreamItems(pluginItem("a", "thought"), pluginItem("b", "todo_list"))).toBe(
      0,
    );
  });

  it("stacks plugin tool rows with native tool rows in either order", () => {
    expect(getGapBetweenStreamItems(pluginItem("a", "tool_call"), toolCallBlock("tc"))).toBe(0);
    expect(getGapBetweenStreamItems(toolCallBlock("tc"), pluginItem("a", "tool_call"))).toBe(0);
  });

  it("spaces plugin tool rows from user and assistant rows like native tool rows", () => {
    const plugin = pluginItem("a", "tool_call");
    const assistant = message;
    const user = userMessage("u");
    const native = toolCallBlock("tc");
    expect(getGapBetweenStreamItems(user, plugin)).toBe(getGapBetweenStreamItems(user, native));
    expect(getGapBetweenStreamItems(user, plugin)).toBe(SPACING[4]);
    expect(getGapBetweenStreamItems(assistant, plugin)).toBe(
      getGapBetweenStreamItems(assistant, native),
    );
    expect(getGapBetweenStreamItems(plugin, assistant)).toBe(
      getGapBetweenStreamItems(native, assistant),
    );
  });

  it("keeps the default gap for plugin rows that are not tool-like", () => {
    expect(
      getGapBetweenStreamItems(pluginItem("a", "assistant_message"), pluginItem("b", "tool_call")),
    ).toBe(SPACING[4]);
  });
});
