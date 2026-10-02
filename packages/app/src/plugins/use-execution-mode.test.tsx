/** @vitest-environment jsdom */
import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "./types";
import type { PluginExecutionPresetCatalog } from "@getpaseo/plugin/client";
import { useExecutionMode } from "./use-execution-mode";

const fixture = vi.hoisted(() => ({ plugins: [] as InstalledPlugin[] }));
vi.mock("./registry", () => ({ useInstalledPlugins: () => fixture.plugins }));
vi.mock("@/composer/agent-controls", () => ({ DraftAgentControls: () => null }));
vi.mock("./execution-controls", () => ({ ExecutionControls: () => null }));

beforeEach(() => {
  fixture.plugins = [];
});

it("keeps an unavailable project default explicit and ignores a stale catalog after switching project", async () => {
  let finishFirst!: (value: PluginExecutionPresetCatalog) => void;
  const loadPresets = vi.fn(({ cwd }: { cwd: string }) =>
    cwd === "/one"
      ? new Promise<PluginExecutionPresetCatalog>((resolve) => {
          finishFirst = resolve;
        })
      : Promise.resolve({
          presets: [{ id: "standard", title: "Standard team" }],
          defaultPresetId: "missing-project-pack",
          unavailableReason: "Configured project team is unavailable",
        }),
  );
  fixture.plugins = [
    {
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
          loadPresets,
          start: async () => ({ agentId: "boss" }),
        },
      ],
    },
  ];
  const { result, rerender } = renderHook(
    ({ cwd }) => useExecutionMode({ serverId: "host", cwd, initialExecutionId: "crew:team" }),
    { initialProps: { cwd: "/one" } },
  );
  rerender({ cwd: "/two" });
  await waitFor(() => expect(result.current.presetsLoading).toBe(false));
  expect(result.current.presetId).toBe("missing-project-pack");
  expect(result.current.presetCatalog?.unavailableReason).toBe(
    "Configured project team is unavailable",
  );
  await act(async () =>
    finishFirst({ presets: [{ id: "old", title: "Old team" }], defaultPresetId: "old" }),
  );
  expect(result.current.presetId).toBe("missing-project-pack");
  act(() => result.current.setPresetId("standard"));
  expect(result.current.presetId).toBe("standard");
  expect(loadPresets).toHaveBeenCalledTimes(2);
});
