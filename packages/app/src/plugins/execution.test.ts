import type {
  PluginExecutionStartInput,
  PluginExecutionModeContribution,
} from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { getExecutionModes, startPluginExecution } from "./execution";
import type { InstalledPlugin } from "./types";

function fixture(
  start: PluginExecutionModeContribution["start"] = vi.fn(async () => ({ agentId: "boss" })),
): InstalledPlugin {
  return {
    id: "crew",
    serverId: "host",
    lifetime: new AbortController(),
    cleanup() {},
    clientBundle: "",
    queryClient: new QueryClient(),
    surfaces: [],
    settingsScreens: [],
    sidebarItems: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    timelineTransformers: [],
    timelineRenderers: [],
    executionModes: [
      {
        id: "team",
        title: "Team",
        icon: "Blocks",
        async loadPresets() {
          return { presets: [] };
        },
        start,
      },
    ],
  };
}

const input = {
  workspaceId: "workspace",
  cwd: "/project",
  presetId: "standard",
  text: "Keep the original request",
  images: [{ data: "image", mimeType: "image/png" }],
  attachments: [],
  idempotencyKey: "draft",
  defaultAgentConfig: { provider: "codex/model", thinkingOptionId: "medium" },
};

describe("plugin execution", () => {
  it("uses host-scoped namespaced modes and removes disabled contributions", () => {
    const plugin = fixture();
    expect(getExecutionModes([plugin], "other")).toEqual([]);
    expect(getExecutionModes([plugin], "host").map((mode) => mode.id)).toEqual(["crew:team"]);
    plugin.lifetime.abort();
    expect(getExecutionModes([plugin], "host")).toEqual([]);
  });

  it("deduplicates concurrent starts while preserving rich input and permits an idempotent retry after failure", async () => {
    let release!: (value: { agentId: string }) => void;
    const start = vi.fn(
      (_request: PluginExecutionStartInput) =>
        new Promise<{ agentId: string }>((resolve) => {
          release = resolve;
        }),
    );
    const plugin = fixture(start);
    const mode = getExecutionModes([plugin], "host")[0]!;
    const first = startPluginExecution(mode, input);
    const second = startPluginExecution(mode, input);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(input);
    release({ agentId: "boss" });
    expect(await first).toEqual(await second);
    start.mockImplementationOnce(async () => {
      throw new Error("offline");
    });
    await expect(startPluginExecution(mode, input)).rejects.toThrow("offline");
    const retry = startPluginExecution(mode, input);
    await Promise.resolve();
    release({ agentId: "boss" });
    await expect(retry).resolves.toEqual({ agentId: "boss" });
    expect(start.mock.calls.map(([request]) => request.idempotencyKey)).toEqual([
      "draft",
      "draft",
      "draft",
    ]);
  });

  it("rejects removed modes before executing a paid start", async () => {
    const plugin = fixture();
    const mode = getExecutionModes([plugin], "host")[0]!;
    plugin.executionModes = [];
    await expect(startPluginExecution(mode, input)).rejects.toThrow("unavailable");
    expect(mode.contribution.start).not.toHaveBeenCalled();
  });
});
