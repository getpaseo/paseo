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
