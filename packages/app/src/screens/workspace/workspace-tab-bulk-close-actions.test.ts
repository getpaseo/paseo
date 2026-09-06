import { describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => {}),
    removeItem: vi.fn(async () => {}),
  },
}));

import {
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
  createWorkspaceTabBulkCloseActions,
} from "@/screens/workspace/workspace-bulk-close";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import { buildWorkspaceTabMenuEntries } from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { collectAllTabs, createWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

type HarnessTabName = "left" | "pinnedAgent" | "anchor" | "pinnedTerminal" | "right";

interface BulkCloseMenuCase {
  menuEntryKey: "close-before" | "close-after" | "close-others";
  remainingTabs: HarnessTabName[];
}

interface BulkCloseMenuHarness {
  menuEntries: ReturnType<typeof buildWorkspaceTabMenuEntries>;
  closeItems: ReturnType<typeof vi.fn>;
  waitForClose: () => Promise<void>;
  getOpenTabIds: () => string[];
  tabIds: Record<HarnessTabName, string>;
}

function createBulkCloseMenuHarness(): BulkCloseMenuHarness {
  let nodeId = 0;
  const workspaceKey = "server:workspace";
  const store = createWorkspaceLayoutStore({
    createNodeId: (prefix) => `${prefix}-${(nodeId += 1)}`,
    createFocusRestorationToken: () => "focus-token",
  });

  function openTab(target: WorkspaceTabTarget): string {
    const tabId = store.getState().openTab({ workspaceKey, target, intent: "new" });
    if (!tabId) throw new Error(`Failed to open ${target.kind} tab`);
    return tabId;
  }

  const leftTabId = openTab({ kind: "file", path: "/repo/left.ts" });
  const pinnedAgentTabId = openTab({ kind: "agent", agentId: "pinned-agent" });
  const anchorTabId = openTab({ kind: "file", path: "/repo/anchor.ts" });
  const pinnedTerminalTabId = openTab({ kind: "terminal", terminalId: "pinned-terminal" });
  const rightTabId = openTab({ kind: "file", path: "/repo/right.ts" });
  const initialLayout = store.getState().layoutByWorkspace[workspaceKey];
  for (const tab of collectAllTabs(initialLayout.root)) {
    if (tab.target.kind === "new_tab") store.getState().closeTab(workspaceKey, tab.tabId);
  }
  store.getState().toggleTabPinned(workspaceKey, pinnedAgentTabId);
  store.getState().toggleTabPinned(workspaceKey, pinnedTerminalTabId);

  function getDescriptors(): WorkspaceTabDescriptor[] {
    const layout = store.getState().layoutByWorkspace[workspaceKey];
    return deriveWorkspacePaneState({
      layout,
      paneId: "main",
      tabs: collectAllTabs(layout.root),
    }).tabs.map((tab) => tab.descriptor);
  }

  const paneTabs = getDescriptors();
  const anchorTab = paneTabs.find((tab) => tab.tabId === anchorTabId);
  if (!anchorTab) throw new Error("Anchor tab is missing");

  const closeItems = vi.fn(async () => ({ agents: [], terminals: [], requestId: "request-1" }));
  const actions = createWorkspaceTabBulkCloseActions({
    labels: {
      beforeTitle: "Close tabs to the left?",
      afterTitle: "Close tabs to the right?",
      othersTitle: "Close other tabs?",
    },
    closeTabs: async ({ tabsToClose, logLabel }) => {
      await closeBulkWorkspaceTabs({
        groups: classifyBulkClosableTabs(tabsToClose),
        client: { closeItems },
        closeTab: async (_tabId, action) => action(),
        closeLayoutOnlyAgent: async () => {},
        closeWorkspaceTabWithCleanup: ({ tabId }) => {
          store.getState().closeTab(workspaceKey, tabId);
        },
        logLabel,
      });
      return true;
    },
  });
  const pendingCloses: Array<Promise<void>> = [];
  const menuEntries = buildWorkspaceTabMenuEntries({
    surface: "desktop",
    tab: anchorTab,
    index: paneTabs.indexOf(anchorTab),
    tabCount: paneTabs.length,
    menuTestIDBase: "workspace-tab-context-anchor",
    onCopyResumeCommand: vi.fn(),
    onCopyAgentId: vi.fn(),
    onCopyTerminalId: vi.fn(),
    onCopyFilePath: vi.fn(),
    onReloadAgent: vi.fn(),
    onRenameTab: vi.fn(),
    onTogglePinTab: vi.fn(),
    onCloseTab: vi.fn(),
    onCloseTabsBefore: (tabId) => {
      pendingCloses.push(actions.closeTabsBefore(tabId, paneTabs));
    },
    onCloseTabsAfter: (tabId) => {
      pendingCloses.push(actions.closeTabsAfter(tabId, paneTabs));
    },
    onCloseOtherTabs: (tabId) => {
      pendingCloses.push(actions.closeOtherTabs(tabId, paneTabs));
    },
  });

  return {
    menuEntries,
    closeItems,
    waitForClose: async () => {
      await Promise.all(pendingCloses);
    },
    getOpenTabIds: () => getDescriptors().map((tab) => tab.tabId),
    tabIds: {
      left: leftTabId,
      pinnedAgent: pinnedAgentTabId,
      anchor: anchorTabId,
      pinnedTerminal: pinnedTerminalTabId,
      right: rightTabId,
    },
  };
}

describe("workspace tab bulk-close actions", () => {
  it.each<BulkCloseMenuCase>([
    {
      menuEntryKey: "close-before",
      remainingTabs: ["pinnedAgent", "anchor", "pinnedTerminal", "right"],
    },
    {
      menuEntryKey: "close-after",
      remainingTabs: ["left", "pinnedAgent", "anchor", "pinnedTerminal"],
    },
    {
      menuEntryKey: "close-others",
      remainingTabs: ["pinnedAgent", "anchor", "pinnedTerminal"],
    },
  ])("protects pinned tabs through the $menuEntryKey context-menu action", async (testCase) => {
    const harness = createBulkCloseMenuHarness();
    const menuEntry = harness.menuEntries.find(
      (entry) => entry.kind === "item" && entry.key === testCase.menuEntryKey,
    );
    if (!menuEntry || menuEntry.kind !== "item") {
      throw new Error(`${testCase.menuEntryKey} menu entry is missing`);
    }

    menuEntry.onSelect();
    await harness.waitForClose();

    const remainingTabIds = testCase.remainingTabs.map((name) => harness.tabIds[name]);
    expect(harness.getOpenTabIds()).toEqual(remainingTabIds);
    expect(harness.closeItems).not.toHaveBeenCalled();
  });
});
