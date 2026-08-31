// @vitest-environment jsdom
//
// jsdom is here for one test: the dirty-preview case drives the promotion through the real
// `usePublishPanelInstanceAttributes` effect, which needs a React renderer.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { renderHook, type RenderHookResult } from "@testing-library/react";
import React from "react";
import { DEFAULT_APP_SETTINGS, type OpenInSidePanePreferences } from "@/hooks/use-settings";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabOpenMode } from "@/workspace-tabs/model";
import {
  openPreferredWorkspacePreview,
  type OpenInSidePaneSource,
} from "@/workspace-tabs/open-beside";

const SERVER_ID = "server-1";
const WORKSPACE_ID = "ws-1";
const WORKSPACE_KEY = `${SERVER_ID}:${WORKSPACE_ID}`;

/** Every source except the Explorer. None of them may touch the pane's preview slot. */
const NON_EXPLORER_SOURCES = ["diffs", "diffFiles", "chatFiles", "subagents"] as const;

/**
 * Mounted panels publishing `modified`. The attribute registry is a module-global Map, so an
 * unmounted panel would leak its dirty flag into the next test.
 */
const mountedPanels: RenderHookResult<void, never>[] = [];

/** `Layout → Open location` set to Side for the Explorer, the setting this suite's last block covers. */
const SIDE_PANE_PREFERENCES: OpenInSidePanePreferences = {
  ...DEFAULT_APP_SETTINGS.openInSidePane,
  explorerFiles: true,
};

/** The agent tab seeded into the main pane, so a side-pane test can prove it split away from it. */
let seedTabId: string | null = null;

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTab: "files",
    explorerTabByCheckout: {},
  });
  // A tree click can only reach a workspace that already has a layout, so seed one the way the
  // workspace screen does before the Explorer is ever shown.
  seedTabId = useWorkspaceLayoutStore.getState().openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
});

afterEach(() => {
  for (const panel of mountedPanels.splice(0)) panel.unmount();
});

interface OpenOptions {
  previewEnabled?: boolean;
  source?: OpenInSidePaneSource;
  preferences?: OpenInSidePanePreferences;
}

function clickFile(path: string, mode: WorkspaceTabOpenMode, options?: OpenOptions): string | null {
  return openPreferredWorkspacePreview({
    isCompact: false,
    workspaceKey: WORKSPACE_KEY,
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
    explorerSidebarPaneId: null,
    lastMainPaneId: null,
    target: { kind: "file", path },
    source: options?.source ?? "explorerFiles",
    preferences: options?.preferences ?? DEFAULT_APP_SETTINGS.openInSidePane,
    mode,
    previewEnabled: options?.previewEnabled ?? true,
  });
}

function singleClick(path: string, options?: OpenOptions) {
  return clickFile(path, "preview", options);
}

function doubleClick(path: string, options?: OpenOptions) {
  // A double click dispatches the single click too, exactly as the browser does.
  clickFile(path, "preview", options);
  return clickFile(path, "normal", options);
}

/** An implicit open from a panel that is not the Explorer file tree. */
function openFromSource(path: string, source: OpenInSidePaneSource) {
  return clickFile(path, "preview", { source });
}

function fileTabs(): WorkspaceTab[] {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout) return [];
  return collectAllTabs(layout.root).filter((tab) => tab.target.kind === "file");
}

function openFiles(): { path: string; preview: boolean }[] {
  return fileTabs().map((tab) => ({
    path: tab.target.kind === "file" ? tab.target.path : "",
    preview: tab.preview === true,
  }));
}

function paneIdHoldingTab(tabId: string | null): string | null {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout || !tabId) return null;
  return collectAllPanes(layout.root).find((pane) => pane.tabIds.includes(tabId))?.id ?? null;
}

function focusedTabId(): string | null {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  if (!layout) return null;
  return findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
}

/** The slice of the pane contract `usePublishPanelInstanceAttributes` reads; the rest is inert. */
function createPaneContextValue(tabId: string, target: WorkspaceTab["target"]): PaneContextValue {
  const noop = () => {};
  return {
    serverId: SERVER_ID,
    workspaceId: WORKSPACE_ID,
    host: "main",
    tabId,
    target,
    openTab: noop,
    openPreferredTarget: noop,
    openPreferredTargetAsNormalTab: noop,
    closeCurrentTab: noop,
    retargetCurrentTab: noop,
    setCurrentTabState: noop,
    openFileInWorkspace: noop,
    openImportSheet: noop,
  };
}

/**
 * Types into the tab, the way the app does it: a panel publishes `modified` through
 * `usePublishPanelInstanceAttributes`, which both marks the buffer and promotes the preview out
 * of the pane's slot. Poking the attribute registry directly would skip the promotion and leave
 * a pane holding two previews — a state the app cannot reach.
 */
function editTab(tabId: string, target: WorkspaceTab["target"]): void {
  const paneContextValue = createPaneContextValue(tabId, target);
  mountedPanels.push(
    renderHook(() => usePublishPanelInstanceAttributes({ modified: true }), {
      wrapper: ({ children }) => <PaneProvider value={paneContextValue}>{children}</PaneProvider>,
    }),
  );
}

describe("Explorer preview tabs", () => {
  it("replaces the preview when the next file is single-clicked", () => {
    singleClick("src/a.ts");
    singleClick("src/b.ts");

    expect(openFiles()).toEqual([{ path: "src/b.ts", preview: true }]);
  });

  it("keeps the preview in place while it is being replaced", () => {
    const firstTabId = singleClick("src/a.ts");
    const secondTabId = singleClick("src/b.ts");

    expect(firstTabId).not.toBeNull();
    expect(secondTabId).toBe(firstTabId);
  });

  it("keeps the previewed file when it is double-clicked", () => {
    const previewTabId = singleClick("src/a.ts");
    const normalTabId = clickFile("src/a.ts", "normal");

    expect(normalTabId).toBe(previewTabId);
    expect(openFiles()).toEqual([{ path: "src/a.ts", preview: false }]);
  });

  it("accumulates a tab per double-clicked file", () => {
    doubleClick("src/a.ts");
    doubleClick("src/b.ts");

    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: false },
    ]);
  });

  it("opens a preview beside normal tabs without replacing them", () => {
    doubleClick("src/a.ts");
    doubleClick("src/b.ts");
    singleClick("src/c.ts");

    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: false },
      { path: "src/c.ts", preview: true },
    ]);
  });

  it("never replaces an edited preview", () => {
    const editedTabId = singleClick("src/a.ts");
    expect(editedTabId).not.toBeNull();
    if (!editedTabId) throw new Error("The Explorer preview did not open");
    editTab(editedTabId, { kind: "file", path: "src/a.ts" });

    singleClick("src/b.ts");

    // Editing kept the file, so the next single click has no slot to reuse and previews beside it.
    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: true },
    ]);
  });

  it("only moves focus when an already open file is clicked", () => {
    const firstTabId = doubleClick("src/a.ts");
    doubleClick("src/b.ts");
    expect(focusedTabId()).not.toBe(firstTabId);

    const revealedTabId = singleClick("src/a.ts");

    expect(revealedTabId).toBe(firstTabId);
    expect(focusedTabId()).toBe(firstTabId);
    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: false },
    ]);
  });

  it("opens a normal tab on every single click when preview tabs are turned off", () => {
    const options = { previewEnabled: false };
    singleClick("src/a.ts", options);
    singleClick("src/b.ts", options);
    singleClick("src/c.ts", options);

    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: false },
      { path: "src/c.ts", preview: false },
    ]);
  });
});

// A preview is never persisted, so tagging one for a panel the user did not click in the Explorer
// would make that tab vanish on reload. Both halves of the gate are locked here: the flag a new tab
// gets, and whether an existing Explorer preview can be taken over.
describe("Preview slots belong to the Explorer", () => {
  it.each(NON_EXPLORER_SOURCES)("opens an ordinary tab for %s", (source) => {
    openFromSource("src/from-panel.ts", source);

    expect(openFiles()).toEqual([{ path: "src/from-panel.ts", preview: false }]);
  });

  it.each(NON_EXPLORER_SOURCES)("leaves the Explorer preview alone for %s", (source) => {
    const previewTabId = singleClick("src/previewed.ts");

    const openedTabId = openFromSource("src/from-panel.ts", source);

    // Same pane, so the slot was reachable and declined rather than simply out of range.
    expect(paneIdHoldingTab(openedTabId)).toBe(paneIdHoldingTab(previewTabId));
    expect(openedTabId).not.toBe(previewTabId);
    expect(openFiles()).toEqual([
      { path: "src/previewed.ts", preview: true },
      { path: "src/from-panel.ts", preview: false },
    ]);
  });
});

// The destination pane is chosen before the slot logic runs, so the preview model is supposed to be
// the same wherever the file lands. Nothing covered that until now.
describe("Explorer preview tabs in the side pane", () => {
  const options = { preferences: SIDE_PANE_PREFERENCES };

  /** Asserts the tab really went to the side pane rather than staying beside the seeded agent. */
  function expectInSidePane(tabId: string | null): void {
    const sidePaneId = useWorkspaceLayoutStore.getState().sidePaneIdByWorkspace[WORKSPACE_KEY];
    expect(seedTabId).toBeTruthy();
    expect(sidePaneId).toBeTruthy();
    expect(paneIdHoldingTab(tabId)).toBe(sidePaneId);
    expect(paneIdHoldingTab(tabId)).not.toBe(paneIdHoldingTab(seedTabId));
  }

  it("reuses one preview slot", () => {
    const firstTabId = singleClick("src/a.ts", options);
    const secondTabId = singleClick("src/b.ts", options);

    expectInSidePane(secondTabId);
    expect(secondTabId).toBe(firstTabId);
    expect(openFiles()).toEqual([{ path: "src/b.ts", preview: true }]);
  });

  it("accumulates a tab per double-clicked file", () => {
    const firstTabId = doubleClick("src/a.ts", options);
    const secondTabId = doubleClick("src/b.ts", options);

    expectInSidePane(firstTabId);
    expectInSidePane(secondTabId);
    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: false },
    ]);
  });

  it("opens a preview beside a normal tab", () => {
    const normalTabId = doubleClick("src/a.ts", options);
    const previewTabId = singleClick("src/b.ts", options);

    expectInSidePane(normalTabId);
    expectInSidePane(previewTabId);
    expect(openFiles()).toEqual([
      { path: "src/a.ts", preview: false },
      { path: "src/b.ts", preview: true },
    ]);
  });
});
