import { describe, expect, it, vi } from "vitest";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import {
  prepareToolCallHistory,
  projectToolCallDetailLevel,
} from "@/tool-calls/detail-level/projection";
import type { TimelineItemTransform } from "./model";
import {
  projectPluginNonToolItems,
  projectPluginTimelineItems,
  projectPluginToolCallItems,
} from "./projection";

function thought(text: string, status: "loading" | "ready" = "loading"): StreamItem {
  return {
    kind: "thought",
    id: "thought-1",
    text,
    status,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function toolCall(callId: string, status: "running" | "completed" = "completed"): ToolCallItem {
  return {
    kind: "tool_call",
    id: `tool-${callId}`,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId,
        name: "custom_tool",
        status,
        error: null,
        detail: {
          type: "unknown",
          input: { callId },
          output: { callId },
        },
        metadata: { callId },
      },
    },
  };
}

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

  it("projects every claimed tool call before overview grouping", () => {
    const calls = [toolCall("call-1"), toolCall("call-2")];
    const transform: TimelineItemTransform = vi.fn(({ item, phase }) => {
      if (item.type !== "tool_call") return undefined;
      return [
        {
          type: "plugin" as const,
          id: item.callId,
          pluginId: "tool-details",
          kind: "tool-detail",
          version: 1,
          data: { callId: item.callId, detail: item.detail, phase },
        },
      ];
    });

    const projected = projectPluginToolCallItems(calls, transform);
    const preparedHistory = prepareToolCallHistory("overview", projected);
    const grouped = projectToolCallDetailLevel({
      level: "overview",
      tail: projected,
      head: [],
      preparedHistory,
      isTurnActive: false,
    });

    expect(transform).toHaveBeenCalledTimes(2);
    expect(transform).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        item: expect.objectContaining({ callId: "call-1" }),
        phase: "complete",
      }),
    );
    expect(transform).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        item: expect.objectContaining({ callId: "call-2" }),
        phase: "complete",
      }),
    );
    expect(grouped.tail.map((item) => item.id)).toEqual([
      "tool-details/call-1",
      "tool-details/call-2",
    ]);
    expect(grouped.groupsByHostId.size).toBe(0);
  });

  it("does not re-project generated plugin rows", () => {
    const calls = [toolCall("call-1"), toolCall("call-2")];
    const transform: TimelineItemTransform = vi.fn(({ item }) => {
      if (item.type !== "tool_call") return undefined;
      return [
        {
          type: "plugin" as const,
          id: item.callId,
          pluginId: "tool-details",
          kind: "tool-detail",
          version: 1,
          data: { callId: item.callId },
        },
      ];
    });

    const projected = projectPluginToolCallItems(calls, transform);
    const final = projectPluginNonToolItems(projected, transform);

    expect(final).toBe(projected);
    expect(transform).toHaveBeenCalledTimes(2);
  });

  it("keeps unclaimed calls eligible for overview grouping", () => {
    const calls = [toolCall("call-1"), toolCall("call-2"), toolCall("call-3")];
    const transform: TimelineItemTransform = ({ item }) => {
      if (item.type !== "tool_call" || item.callId !== "call-3") return undefined;
      return [
        {
          type: "plugin",
          id: item.callId,
          pluginId: "tool-details",
          kind: "tool-detail",
          version: 1,
          data: { callId: item.callId },
        },
      ];
    };

    const projected = projectPluginToolCallItems(calls, transform);
    const preparedHistory = prepareToolCallHistory("overview", projected);
    const grouped = projectToolCallDetailLevel({
      level: "overview",
      tail: projected,
      head: [],
      preparedHistory,
      isTurnActive: false,
    });

    expect(grouped.tail.map((item) => item.id)).toEqual(["tool-call-1", "tool-details/call-3"]);
    expect(grouped.groupsByHostId.get("tool-call-1")?.run.calls).toEqual(calls.slice(0, 2));
  });

  it("passes streaming and complete phases for the same tool call", () => {
    const running = toolCall("call-1", "running");
    const completed = toolCall("call-1", "completed");
    const transform: TimelineItemTransform = vi.fn(({ item, phase }) => {
      if (item.type !== "tool_call") return undefined;
      return [
        {
          type: "plugin" as const,
          id: item.callId,
          pluginId: "tool-details",
          kind: "tool-detail",
          version: 1,
          data: { callId: item.callId, phase },
        },
      ];
    });

    projectPluginToolCallItems([running], transform);
    projectPluginToolCallItems([completed], transform);

    expect(transform).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        item: expect.objectContaining({ callId: "call-1" }),
        phase: "streaming",
      }),
    );
    expect(transform).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        item: expect.objectContaining({ callId: "call-1" }),
        phase: "complete",
      }),
    );
  });

  it("does not re-run tool-call transformers on grouped hosts", () => {
    const calls = [toolCall("call-1"), toolCall("call-2")];
    const transform: TimelineItemTransform = vi.fn(({ item }) => {
      if (item.type !== "reasoning") return undefined;
      return [
        {
          type: "plugin" as const,
          id: "reasoning",
          pluginId: "tool-details",
          kind: "reasoning",
          version: 1,
          data: { text: item.text },
        },
      ];
    });

    const projected = projectPluginToolCallItems(calls, transform);
    const preparedHistory = prepareToolCallHistory("overview", projected);
    const grouped = projectToolCallDetailLevel({
      level: "overview",
      tail: projected,
      head: [],
      preparedHistory,
      isTurnActive: false,
    });
    const final = projectPluginNonToolItems([...grouped.tail, thought("note", "ready")], transform);

    expect(transform).toHaveBeenCalledTimes(3);
    expect(final.map((item) => item.kind)).toEqual(["tool_call", "plugin"]);
    expect(transform).toHaveBeenLastCalledWith(
      expect.objectContaining({
        item: { type: "reasoning", text: "note" },
        phase: "complete",
      }),
    );
  });
});
