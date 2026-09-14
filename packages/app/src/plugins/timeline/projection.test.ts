import { describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import type { TimelineItemTransform } from "./model";
import { projectPluginTimelineItems } from "./projection";

function thought(text: string, status: "loading" | "ready" = "loading"): StreamItem {
  return {
    kind: "thought",
    id: "thought-1",
    text,
    status,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function block(groupId: string, blockIndex: number, text: string): StreamItem {
  return {
    kind: "assistant_message",
    id: `${groupId}:block:${blockIndex}`,
    text,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    blockGroupId: groupId,
    blockIndex,
  };
}

const cardTransform: TimelineItemTransform = ({ item, sourceId }) =>
  item.type === "assistant_message"
    ? [
        {
          type: "plugin" as const,
          id: `${sourceId}/0`,
          pluginId: "card",
          kind: "card",
          version: 1,
          data: { text: item.text },
        },
      ]
    : undefined;

describe("plugin timeline projection", () => {
  it("does not expose mutable tool detail from stream state", () => {
    const detail = { type: "read" as const, filePath: "/repo/original.ts" };
    const source: StreamItem = {
      kind: "tool_call",
      id: "tool-1",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call-1",
          name: "Read",
          status: "completed",
          error: null,
          detail,
        },
      },
    };
    const mutateDetail: TimelineItemTransform = ({ item }) => {
      if (item.type === "tool_call" && item.detail.type === "read") {
        item.detail.filePath = "/repo/mutated.ts";
      }
      return undefined;
    };

    expect(() => projectPluginTimelineItems([source], mutateDetail)).toThrow(TypeError);
    expect(detail.filePath).toBe("/repo/original.ts");
  });

  it("projects a streaming reasoning row from its first delta", () => {
    const transform: TimelineItemTransform = vi.fn(({ item, phase, sourceId }) => [
      {
        type: "plugin" as const,
        id: `${sourceId}/0`,
        pluginId: "inline-thinking",
        kind: "reasoning",
        version: 1,
        data: { text: item.type === "reasoning" ? item.text : "", phase },
      },
    ]);

    expect(projectPluginTimelineItems([thought("First")], transform)).toMatchObject([
      {
        kind: "plugin",
        id: "inline-thinking/thought-1/0",
        data: { text: "First", phase: "streaming" },
      },
    ]);
  });

  it("memoizes projection on the source row reference", () => {
    const source = thought("Stable");
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    projectPluginTimelineItems([source], transform);
    projectPluginTimelineItems([source], transform);

    expect(transform).toHaveBeenCalledOnce();
  });

  it("preserves whether a notification row came from an agent error or a notice", () => {
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    const timestamp = new Date("2026-01-01T00:00:00.000Z");

    projectPluginTimelineItems(
      [
        {
          kind: "notification",
          sourceType: "error",
          id: "error-1",
          level: "error",
          message: "Agent failed",
          timestamp,
        },
        {
          kind: "notification",
          sourceType: "notification",
          id: "notice-1",
          level: "error",
          message: "Extension reported an error",
          timestamp,
        },
      ],
      transform,
    );

    expect(transform).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ item: { type: "error", message: "Agent failed" } }),
    );
    expect(transform).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        item: {
          type: "notification",
          level: "error",
          message: "Extension reported an error",
        },
      }),
    );
  });

  it("reprojects when streaming produces a new source row", () => {
    const transform: TimelineItemTransform = vi.fn(() => undefined);
    projectPluginTimelineItems([thought("First")], transform);
    projectPluginTimelineItems([thought("First second")], transform);

    expect(transform).toHaveBeenCalledTimes(2);
  });

  it("filters and explodes source rows", () => {
    const source = thought("Split", "ready");
    const exploded = projectPluginTimelineItems([source], ({ sourceId }) => [
      {
        type: "plugin",
        id: `${sourceId}/left`,
        pluginId: "split",
        kind: "part",
        version: 1,
        data: { side: "left" },
      },
      {
        type: "plugin",
        id: `${sourceId}/right`,
        pluginId: "split",
        kind: "part",
        version: 1,
        data: { side: "right" },
      },
    ]);
    const filtered = projectPluginTimelineItems([source], () => []);

    expect(exploded.map((item) => item.id)).toEqual([
      "split/thought-1/left",
      "split/thought-1/right",
    ]);
    expect(filtered).toEqual([]);
  });
});

describe("assistant block groups", () => {
  it("transforms a promoted block group as one assistant message", () => {
    const transform = vi.fn(cardTransform);
    const items = [
      block("msg-1", 0, "# Title"),
      block("msg-1", 1, "First paragraph"),
      block("msg-1", 2, "- one\n- two"),
    ];

    const projected = projectPluginTimelineItems(items, transform);

    expect(transform).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledWith({
      item: { type: "assistant_message", text: "# Title\n\nFirst paragraph\n\n- one\n- two" },
      phase: "complete",
      sourceId: "msg-1:block:0",
    });
    expect(projected).toEqual([
      expect.objectContaining({
        kind: "plugin",
        id: "card/msg-1:block:0/0",
        timestamp: items[0]?.timestamp,
        data: { text: "# Title\n\nFirst paragraph\n\n- one\n- two" },
      }),
    ]);
  });

  it("leaves a block group untouched when no transformer claims it", () => {
    const transform = vi.fn(() => undefined);
    const items = [block("msg-1", 0, "Intro"), block("msg-1", 1, "Body")];

    expect(projectPluginTimelineItems(items, transform)).toBe(items);
    expect(transform).toHaveBeenCalledOnce();
    expect(transform).toHaveBeenCalledWith(
      expect.objectContaining({ item: { type: "assistant_message", text: "Intro\n\nBody" } }),
    );
  });

  it("keeps the trailing newline of a block that is still streaming", () => {
    const transform = vi.fn(cardTransform);

    projectPluginTimelineItems(
      [block("msg-1", 0, "Intro"), block("msg-1", 1, "Body\n")],
      transform,
    );

    expect(transform).toHaveBeenCalledWith({
      item: { type: "assistant_message", text: "Intro\n\nBody\n" },
      phase: "complete",
      sourceId: "msg-1:block:0",
    });
  });

  it("projects a lone live block by its own id", () => {
    const transform = vi.fn(cardTransform);

    const projected = projectPluginTimelineItems([block("msg-1", 2, "Live")], transform);

    expect(transform).toHaveBeenCalledWith({
      item: { type: "assistant_message", text: "Live" },
      phase: "complete",
      sourceId: "msg-1:block:2",
    });
    expect(projected.map((item) => item.id)).toEqual(["card/msg-1:block:2/0"]);
  });

  it("keeps unrelated rows and other assistant rows separate from a group", () => {
    const transform = vi.fn(cardTransform);
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const items: StreamItem[] = [
      { kind: "user_message", id: "user-1", text: "Hi", timestamp },
      block("msg-1", 0, "One"),
      block("msg-1", 1, "Two"),
      thought("Thinking", "ready"),
      block("msg-2", 0, "Other"),
      { kind: "assistant_message", id: "plain", text: "Plain", timestamp },
    ];

    const projected = projectPluginTimelineItems(items, transform);

    expect(projected.map((item) => item.id)).toEqual([
      "user-1",
      "card/msg-1:block:0/0",
      "thought-1",
      "card/msg-2:block:0/0",
      "card/plain/0",
    ]);
    const assistantCalls = transform.mock.calls
      .map(([input]) => input)
      .filter((input) => input.item.type === "assistant_message")
      .map((input) => ({
        sourceId: input.sourceId,
        text: input.item.type === "assistant_message" ? input.item.text : "",
      }));
    expect(assistantCalls).toEqual([
      { sourceId: "msg-1:block:0", text: "One\n\nTwo" },
      { sourceId: "msg-2:block:0", text: "Other" },
      { sourceId: "plain", text: "Plain" },
    ]);
  });

  it("removes every block of a group when the transformer returns no items", () => {
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const items: StreamItem[] = [
      { kind: "user_message", id: "user-1", text: "Hi", timestamp },
      block("msg-1", 0, "One"),
      block("msg-1", 1, "Two"),
    ];

    const projected = projectPluginTimelineItems(items, ({ item }) =>
      item.type === "assistant_message" ? [] : undefined,
    );

    expect(projected.map((item) => item.id)).toEqual(["user-1"]);
  });

  it("memoizes an unchanged block group and reprojects when a block is promoted", () => {
    const transform = vi.fn(cardTransform);
    const first = block("msg-1", 0, "One");
    const second = block("msg-1", 1, "Two");

    const initial = projectPluginTimelineItems([first, second], transform);
    const repeated = projectPluginTimelineItems([first, second], transform);
    expect(transform).toHaveBeenCalledOnce();
    expect(repeated[0]).toBe(initial[0]);

    const grown = projectPluginTimelineItems(
      [first, second, block("msg-1", 2, "Three")],
      transform,
    );
    expect(transform).toHaveBeenCalledTimes(2);
    expect(transform).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: { type: "assistant_message", text: "One\n\nTwo\n\nThree" },
        sourceId: "msg-1:block:0",
      }),
    );
    expect(grown.map((item) => item.id)).toEqual(["card/msg-1:block:0/0"]);
  });
});
