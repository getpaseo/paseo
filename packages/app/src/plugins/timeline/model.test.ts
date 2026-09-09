import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "../types";
import { transformTimelineItem } from "./model";

function plugin(input: {
  id: string;
  transform: InstalledPlugin["timelineTransformers"][number]["transform"];
}): InstalledPlugin {
  return {
    id: input.id,
    serverId: "host-1",
    clientBundle: "bundle",
    queryClient: new QueryClient(),
    cleanup: () => {},
    settingsScreens: [],
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [
      {
        id: "report",
        query: { itemType: "tool_call" },
        transform: input.transform as Extract<
          InstalledPlugin["timelineTransformers"][number],
          { query: { itemType: "tool_call" } }
        >["transform"],
      },
    ],
    timelineRenderers: [],
  };
}

const toolCall = {
  type: "tool_call" as const,
  callId: "call-1",
  name: "shell",
  detail: { type: "unknown" as const, input: null, output: null },
  status: "completed" as const,
  error: null,
};

describe("plugin timeline transforms", () => {
  it("adds installation and source identity to plain transformed items", () => {
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      plugins: [
        plugin({
          id: "reports",
          transform: () => ({
            items: [
              {
                type: "plugin" as const,
                kind: "test-report",
                version: 1,
                data: { passed: 4 },
              },
            ],
          }),
        }),
      ],
    });

    expect(transformed).toEqual([
      {
        type: "plugin",
        id: "agent_tool_call-1/0",
        pluginId: "reports",
        kind: "test-report",
        version: 1,
        data: { passed: 4 },
      },
    ]);
  });

  it("keeps the source item when no transformer returns a result", () => {
    expect(
      transformTimelineItem({
        item: toolCall,
        phase: "complete",
        sourceId: "agent_tool_call-1",
        plugins: [plugin({ id: "reports", transform: () => undefined })],
      }),
    ).toBeUndefined();
  });

  it("accepts an empty replacement and stops after the first result", () => {
    const second = vi.fn(() => ({ items: [] }));
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      plugins: [
        plugin({ id: "first", transform: () => ({ items: [] }) }),
        plugin({ id: "second", transform: second }),
      ],
    });

    expect(transformed).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it("rejects non-JSON data without breaking the timeline", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      plugins: [
        plugin({
          id: "broken",
          transform: () => ({
            items: [
              {
                type: "plugin" as const,
                kind: "bad-data",
                version: 1,
                data: { value: Number.NaN },
              },
            ],
          }),
        }),
      ],
    });

    expect(transformed).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("rejects class instances disguised as JSON data", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      plugins: [
        plugin({
          id: "broken",
          transform: () => ({
            items: [
              {
                type: "plugin" as const,
                kind: "bad-data",
                version: 1,
                data: { createdAt: new Date() } as never,
              },
            ],
          }),
        }),
      ],
    });

    expect(transformed).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("takes a JSON snapshot of transformed data", () => {
    const data = { passed: 4 };
    const transformed = transformTimelineItem({
      item: toolCall,
      phase: "complete",
      sourceId: "agent_tool_call-1",
      plugins: [
        plugin({
          id: "reports",
          transform: () => ({
            items: [{ type: "plugin" as const, kind: "test-report", version: 1, data }],
          }),
        }),
      ],
    });

    data.passed = 0;
    expect(transformed?.[0]?.data).toEqual({ passed: 4 });
  });

  it("passes phase and preserves explicit output identity", () => {
    const transform = vi.fn(() => ({
      items: [
        {
          type: "plugin" as const,
          id: "summary",
          kind: "test-report",
          version: 1,
          data: { passed: 4 },
        },
      ],
    }));

    const transformed = transformTimelineItem({
      item: { ...toolCall, status: "running" },
      phase: "streaming",
      sourceId: "agent_tool_call-1",
      plugins: [plugin({ id: "reports", transform })],
    });

    expect(transform).toHaveBeenCalledWith({
      item: { ...toolCall, status: "running" },
      phase: "streaming",
    });
    expect(transformed?.[0]?.id).toBe("summary");
  });
});
