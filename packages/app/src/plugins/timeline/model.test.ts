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
    surfaces: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSide: null,
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
  it("adds the installation identity to plain transformed items", () => {
    const transformed = transformTimelineItem(toolCall, [
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
    ]);

    expect(transformed).toEqual([
      {
        type: "plugin",
        pluginId: "reports",
        kind: "test-report",
        version: 1,
        data: { passed: 4 },
      },
    ]);
  });

  it("keeps the source item when no transformer returns a result", () => {
    expect(
      transformTimelineItem(toolCall, [plugin({ id: "reports", transform: () => undefined })]),
    ).toBeUndefined();
  });

  it("accepts an empty replacement and stops after the first result", () => {
    const second = vi.fn(() => ({ items: [] }));
    const transformed = transformTimelineItem(toolCall, [
      plugin({ id: "first", transform: () => ({ items: [] }) }),
      plugin({ id: "second", transform: second }),
    ]);

    expect(transformed).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });

  it("rejects non-JSON data without breaking the timeline", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transformed = transformTimelineItem(toolCall, [
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
    ]);

    expect(transformed).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("rejects class instances disguised as JSON data", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const transformed = transformTimelineItem(toolCall, [
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
    ]);

    expect(transformed).toBeUndefined();
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });

  it("takes a JSON snapshot of transformed data", () => {
    const data = { passed: 4 };
    const transformed = transformTimelineItem(toolCall, [
      plugin({
        id: "reports",
        transform: () => ({
          items: [{ type: "plugin" as const, kind: "test-report", version: 1, data }],
        }),
      }),
    ]);

    data.passed = 0;
    expect(transformed?.[0]?.data).toEqual({ passed: 4 });
  });
});
