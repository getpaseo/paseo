import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import {
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  placeTerminalTabInPane,
  resolveImplicitTerminalPlacement,
} from "@/workspace-tabs/terminal-open-location";

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

describe("placeTerminalTabInPane", () => {
  beforeEach(() => {
    useWorkspaceLayoutStore.setState({
      layoutByWorkspace: {},
      explorerSidebarPaneIdByWorkspace: {},
      sidePaneIdByWorkspace: {},
      bottomPaneIdByWorkspace: {},
      splitSizesByWorkspace: {},
    });
  });

  it("swaps a reconcile-created terminal tab into the dock and restores the main placeholder", () => {
    const store = useWorkspaceLayoutStore.getState();
    // The reconcile effect opened the terminal in the focused main pane first.
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "terminal", terminalId: "t1" },
      intent: "new",
    });
    const dockPaneId = store.ensureBottomPane(WORKSPACE_KEY)!;

    placeTerminalTabInPane({
      workspaceKey: WORKSPACE_KEY,
      placement: { mode: "prefer", paneId: dockPaneId },
      terminalId: "t1",
    });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const dockAfter = findPaneById(layout.root, dockPaneId)!;
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab.target]));
    expect(dockAfter.tabIds.map((tabId) => tabsById.get(tabId))).toEqual([
      { kind: "terminal", terminalId: "t1" },
    ]);
    expect(layout.focusedPaneId).toBe(dockPaneId);

    const mainPane = findPaneById(layout.root, "main")!;
    expect(mainPane.tabIds.map((tabId) => tabsById.get(tabId))).toEqual([{ kind: "new_tab" }]);
  });

  it("opens the terminal into the dock placeholder when no stray tab exists", () => {
    const store = useWorkspaceLayoutStore.getState();
    const dockPaneId = store.ensureBottomPane(WORKSPACE_KEY)!;

    placeTerminalTabInPane({
      workspaceKey: WORKSPACE_KEY,
      placement: { mode: "prefer", paneId: dockPaneId },
      terminalId: "t1",
    });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    const dock = findPaneById(layout.root, dockPaneId)!;
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab.target]));
    expect(dock.tabIds.map((tabId) => tabsById.get(tabId))).toEqual([
      { kind: "terminal", terminalId: "t1" },
    ]);
    expect(layout.focusedPaneId).toBe(dockPaneId);
  });
});
