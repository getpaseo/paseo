import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveImplicitTerminalPlacement } from "@/workspace-tabs/terminal-open-location";

const WORKSPACE_KEY = "server-1:workspace-1";
const OPEN_DESTINATION = { kind: "open" } as const;

function resolve(input: {
  location: "main" | "side" | "bottom";
  isCompact?: boolean;
  supportsPaneSplits?: boolean;
  destination?: { kind: "open"; paneId?: string } | { kind: "replace"; tabId: string };
}) {
  return resolveImplicitTerminalPlacement({
    isCompact: input.isCompact ?? false,
    supportsPaneSplits: input.supportsPaneSplits ?? true,
    persistenceKey: WORKSPACE_KEY,
    location: input.location,
    destination: input.destination ?? OPEN_DESTINATION,
  });
}

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    bottomPaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

describe("resolveImplicitTerminalPlacement", () => {
  it("docks an implicit terminal and reuses the remembered dock", () => {
    const first = resolve({ location: "bottom" });
    const rememberedPaneId =
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY];

    expect(rememberedPaneId).toBeTruthy();
    expect(first).toEqual({ mode: "prefer", paneId: rememberedPaneId });

    const second = resolve({ location: "bottom" });

    expect(second).toEqual({ mode: "prefer", paneId: rememberedPaneId });
  });

  it("prefers the side pane when configured", () => {
    const placement = resolve({ location: "side" });
    const sidePaneId = useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY];

    expect(sidePaneId).toBeTruthy();
    expect(placement).toEqual({ mode: "prefer", paneId: sidePaneId });
    expect(
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });

  it("returns no placement for the main location", () => {
    expect(resolve({ location: "main" })).toBeUndefined();
    expect(
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
    expect(useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });

  it("lets an explicit pane target win without creating a dock", () => {
    expect(
      resolve({ location: "bottom", destination: { kind: "open", paneId: "main" } }),
    ).toBeUndefined();
    expect(
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });

  it("falls back to the focused pane on compact layouts", () => {
    expect(resolve({ location: "bottom", isCompact: true })).toBeUndefined();
    expect(
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });

  it("falls back to the focused pane where desktop pane splits cannot render", () => {
    expect(resolve({ location: "bottom", supportsPaneSplits: false })).toBeUndefined();
    expect(
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });

  it("ignores replacement destinations", () => {
    expect(
      resolve({ location: "bottom", destination: { kind: "replace", tabId: "tab-1" } }),
    ).toBeUndefined();
    expect(
      useWorkspaceLayoutStore.getState().bottomPaneIdByWorkspace[WORKSPACE_KEY],
    ).toBeUndefined();
  });
});
