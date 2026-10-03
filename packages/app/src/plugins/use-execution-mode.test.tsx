/** @vitest-environment jsdom */
import { QueryClient } from "@tanstack/react-query";
import React, { useCallback, type MouseEvent } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "./types";
import type { PluginExecutionPresetCatalog } from "@getpaseo/plugin/client";
import type { ComboboxProps } from "@/components/ui/combobox";
import { useExecutionMode } from "./use-execution-mode";

const fixture = vi.hoisted(() => ({ plugins: [] as InstalledPlugin[], compact: true }));
vi.mock("./registry", () => ({ useInstalledPlugins: () => fixture.plugins }));
vi.mock("@/composer/agent-controls", () => ({ DraftAgentControls: () => null }));
vi.mock("./execution-controls", () => ({ ExecutionControls: () => null }));
vi.mock("@/constants/layout", () => ({ useIsCompactFormFactor: () => fixture.compact }));
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ open, title, options, onSelect, onOpenChange, footer }: ComboboxProps) => {
    const select = useCallback(
      (event: MouseEvent<HTMLDivElement>) => {
        const target = (event.target as HTMLElement).closest("button[data-preset-id]");
        const id = target?.getAttribute("data-preset-id");
        if (id === undefined || id === null) return;
        onSelect(id);
        onOpenChange?.(false);
      },
      [onSelect, onOpenChange],
    );
    return open ? (
      <div role="dialog" aria-label={title} onClick={select}>
        {options.map((option) => (
          <button key={option.id} type="button" data-preset-id={option.id}>
            {option.label}
          </button>
        ))}
        {footer}
      </div>
    ) : null;
  },
}));

beforeEach(() => {
  cleanup();
  fixture.plugins = [];
  fixture.compact = true;
});

const controlsProps = {
  modes: [],
  executionId: "kitchen",
  catalog: {
    presets: [
      { id: "standard", title: "Standard team" },
      { id: "basic", title: "Basic team" },
    ],
  },
  presetId: "standard",
  loading: false,
  error: null,
  disabled: false,
};

it("keeps compact team management in the preset sheet and closes it before navigation", async () => {
  const { ExecutionControls } =
    await vi.importActual<typeof import("./execution-controls")>("./execution-controls");
  const onManage = vi.fn();
  render(
    <ExecutionControls
      {...controlsProps}
      onExecutionChange={vi.fn()}
      onPresetChange={vi.fn()}
      onManage={onManage}
    />,
  );
  expect(screen.queryByRole("button", { name: "Manage teams" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Team preset" }));
  expect(screen.getByRole("dialog", { name: "Team preset" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage teams" }));
  expect(onManage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "Team preset" })).toBeNull();
});

it("keeps desktop management inline and preserves ordinary preset selection", async () => {
  fixture.compact = false;
  const { ExecutionControls } =
    await vi.importActual<typeof import("./execution-controls")>("./execution-controls");
  const onManage = vi.fn();
  const onPresetChange = vi.fn();
  render(
    <ExecutionControls
      {...controlsProps}
      onExecutionChange={vi.fn()}
      onPresetChange={onPresetChange}
      onManage={onManage}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Manage teams" }));
  expect(onManage).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Team preset" }));
  fireEvent.click(screen.getByRole("button", { name: "Basic team" }));
  expect(onPresetChange).toHaveBeenCalledWith("basic");
  expect(onManage).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog", { name: "Team preset" })).toBeNull();
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
