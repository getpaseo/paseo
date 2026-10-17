/**
 * @vitest-environment jsdom
 */
import { renderHook } from "@testing-library/react";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import type { PluginWorkspaceRowAccessoryProps } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import type { EvaluatedWorkspaceRowAccessory, InstalledPlugin } from "./types";
import {
  hasLargeWorkspaceRowAccessory,
  nextLargeRailMemory,
  selectWorkspaceRowAccessory,
  useWorkspaceRowAccessory,
  WorkspaceRowLeading,
  type WorkspaceRowAccessories,
  type WorkspaceRowAccessoryTarget,
} from "./workspace-row-accessory";

let hostClient: object | null = {};
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => hostClient }));
vi.mock("@/contexts/toast-context", () => ({ useToast: () => ({}) }));
vi.mock("./registry", () => ({
  useInstalledPlugins: () => [],
  pluginRegistry: {
    subscribe: () => () => undefined,
    getSnapshot: () => [],
    hasCatalog: () => true,
  },
}));
vi.mock("./client-state/source", () => ({ createPluginClientStateSource: () => ({}) }));
vi.mock("@/components/sidebar/project-leading-visual", async () => {
  const ReactNative = await import("react-native");
  return {
    ProjectStatusBadge: ({ statusBucket }: { statusBucket: string }) => (
      <ReactNative.Text>{`badge:${statusBucket}`}</ReactNative.Text>
    ),
  };
});
vi.mock("./popover", () => ({
  PluginEnvironmentProvider: ({ children }: { children: React.ReactNode }) => children,
}));

function plugin(serverId: string, workspaceRowAccessories: EvaluatedWorkspaceRowAccessory[]) {
  return { id: "row-example", serverId, workspaceRowAccessories } as unknown as InstalledPlugin;
}

const workspace = {
  serverId: "host",
  workspaceId: "ws-1",
  workspaceKey: "host:ws-1",
  statusBucket: "running",
} as unknown as SidebarWorkspaceEntry;

let glyphProps: PluginWorkspaceRowAccessoryProps | null = null;
function Glyph(props: PluginWorkspaceRowAccessoryProps) {
  glyphProps = props;
  return <Text>glyph</Text>;
}
function Exploding(): React.ReactNode {
  throw new Error("render failed");
}

const glyphTarget: WorkspaceRowAccessoryTarget = {
  plugin: plugin("host", []),
  accessory: { id: "glyph", Component: Glyph, size: "large", sequence: 1 },
};
const explodingTarget: WorkspaceRowAccessoryTarget = {
  plugin: plugin("host", []),
  accessory: { id: "glyph", Component: Exploding, size: "status", sequence: 1 },
};

const glyphRow = { target: glyphTarget, largeRail: true };
const noAccessories = { target: null, largeRail: false };
const explodingRow = { target: explodingTarget, largeRail: false };

describe("selectWorkspaceRowAccessory", () => {
  it("picks the most recently registered accessory of the row's host", () => {
    const glyph = (id: string, sequence: number) => ({
      id,
      Component: Glyph,
      size: "status" as const,
      sequence,
    });
    const older = plugin("host", [glyph("first", 1), glyph("second", 4)]);
    const newer = plugin("host", [glyph("third", 3)]);
    const otherHost = plugin("other", [glyph("elsewhere", 9)]);

    const target = selectWorkspaceRowAccessory([older, newer, otherHost], "host");

    expect(target?.plugin).toBe(older);
    expect(target?.accessory.id).toBe("second");
    expect(selectWorkspaceRowAccessory([otherHost], "host")).toBeNull();
  });

  it("widens every row when any host has a large accessory", () => {
    const glyph = (size: "status" | "large") => ({ id: size, Component: Glyph, size, sequence: 1 });
    const loaded = () => true;

    expect(hasLargeWorkspaceRowAccessory([plugin("host", [glyph("status")])], [], loaded)).toBe(
      false,
    );
    expect(
      hasLargeWorkspaceRowAccessory(
        [plugin("host", [glyph("status")]), plugin("other", [glyph("large")])],
        [],
        loaded,
      ),
    ).toBe(true);
  });

  it("holds a remembered large rail until that host's plugins are evaluated", () => {
    const evaluated = new Set<string>();
    const hasCatalog = (serverId: string) => evaluated.has(serverId);

    expect(hasLargeWorkspaceRowAccessory([], ["host"], hasCatalog)).toBe(true);
    evaluated.add("host");
    expect(hasLargeWorkspaceRowAccessory([], ["host"], hasCatalog)).toBe(false);
  });
});

describe("nextLargeRailMemory", () => {
  const large = { id: "large", Component: Glyph, size: "large" as const, sequence: 1 };
  const evaluated =
    (...hosts: string[]) =>
    (serverId: string) =>
      hosts.includes(serverId);

  const pendingFor = (milliseconds: number) => () => milliseconds;

  it("forgets a host whose evaluated catalog has no large accessory", () => {
    expect(nextLargeRailMemory(["host"], [], evaluated("host"), pendingFor(0))).toEqual([]);
  });

  it("keeps a remembered host while its catalog may still arrive, and only that long", () => {
    expect(nextLargeRailMemory(["offline"], [], evaluated(), pendingFor(5_000))).toEqual([
      "offline",
    ]);
    expect(nextLargeRailMemory(["offline"], [], evaluated(), pendingFor(30_000))).toEqual([]);
    expect(
      nextLargeRailMemory(
        ["offline"],
        [plugin("host", [large])],
        evaluated("host"),
        pendingFor(30_000),
      ),
    ).toEqual(["host"]);
  });
});

describe("without plugins", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("gives rows no accessory and no rail", () => {
    const { result } = renderHook(() => useWorkspaceRowAccessory("host"));

    expect(result.current).toEqual({ target: null, largeRail: false });
  });

  // Normal rows lead with the status indicator, hoisted rows with the project icon.
  it.each([
    ["a normal row", <Text key="status">status dot</Text>],
    ["a hoisted row", <Text key="icon">project icon</Text>],
  ])("renders exactly the native leading visual of %s", (_row, native) => {
    act(() => root.render(native));
    const upstream = container.innerHTML;

    act(() =>
      root.render(
        <WorkspaceRowLeading
          accessories={noAccessories}
          workspace={workspace}
          isHovered={false}
          isSelected={false}
          backdrop="surfaceSidebar"
          loading={false}
        >
          {native}
        </WorkspaceRowLeading>,
      ),
    );

    expect(container.innerHTML).toBe(upstream);
  });
});

describe("WorkspaceRowLeading", () => {
  let root: Root;
  let container: HTMLElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    glyphProps = null;
    hostClient = {};
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function renderSlot(accessories: WorkspaceRowAccessories) {
    act(() => {
      root.render(
        <WorkspaceRowLeading
          accessories={accessories}
          workspace={workspace}
          isHovered={false}
          isSelected
          backdrop="surfaceSidebar"
          loading={false}
        >
          <Text>native dot</Text>
        </WorkspaceRowLeading>,
      );
    });
  }

  it("mounts the accessory in the leading slot with the native status as a badge", () => {
    renderSlot(glyphRow);

    expect(container.textContent).toBe("glyphbadge:running");
    expect(glyphProps).toMatchObject({
      serverId: "host",
      workspaceId: "ws-1",
      workspaceKey: "host:ws-1",
      statusBucket: "running",
      isHovered: false,
      isSelected: true,
      size: 40,
    });
  });

  it("gives the row its native slot back when the accessory throws", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderSlot(explodingRow);

    expect(container.textContent).toBe("native dot");
  });

  it("keeps the native slot while the plugin's host runtime is not ready", () => {
    hostClient = null;

    renderSlot(glyphRow);

    expect(container.textContent).toBe("native dot");
    expect(glyphProps).toBeNull();
  });
});
