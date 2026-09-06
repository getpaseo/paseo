import { describe, expect, it, vi } from "vitest";
import { executeCloseWorkspacePaneAction } from "@/screens/workspace/workspace-pane-close";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";

function createTab(
  tabId: string,
  target: WorkspaceTabDescriptor["target"],
  isPinned = false,
): WorkspaceTabDescriptor {
  return {
    key: tabId,
    tabId,
    kind: target.kind,
    target,
    isPinned,
  };
}

describe("workspace pane close action", () => {
  it("relocates pinned tabs before the real action tears down the pane", async () => {
    const pinnedAgentTab = createTab("agent_pinned", { kind: "agent", agentId: "pinned" }, true);
    const pinnedTerminalTab = createTab(
      "terminal_pinned",
      { kind: "terminal", terminalId: "pinned" },
      true,
    );
    const unpinnedTab = createTab("file_/repo/temporary.ts", {
      kind: "file",
      path: "/repo/temporary.ts",
    });
    const survivingTab = createTab("agent_surviving", {
      kind: "agent",
      agentId: "surviving",
    });
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "root",
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            {
              kind: "pane",
              pane: {
                id: "closing",
                tabIds: [pinnedAgentTab.tabId, pinnedTerminalTab.tabId, unpinnedTab.tabId],
                focusedTabId: unpinnedTab.tabId,
              },
            },
            {
              kind: "pane",
              pane: {
                id: "surviving",
                tabIds: [survivingTab.tabId],
                focusedTabId: survivingTab.tabId,
              },
            },
          ],
        },
      },
      focusedPaneId: "closing",
    };
    const canMoveTabsToPane = vi.fn(() => true);
    const closeTabs = vi.fn(async () => true);
    const moveTabToPane = vi.fn(() => true);
    const closePane = vi.fn();

    const closed = await executeCloseWorkspacePaneAction({
      layout,
      paneId: "closing",
      explorerSidebarPaneId: null,
      tabsById: new Map([
        [pinnedAgentTab.tabId, pinnedAgentTab],
        [pinnedTerminalTab.tabId, pinnedTerminalTab],
        [unpinnedTab.tabId, unpinnedTab],
        [survivingTab.tabId, survivingTab],
      ]),
      title: "Close pane",
      canMoveTabsToPane,
      closeTabs,
      moveTabToPane,
      closePane,
    });

    expect(closed).toBe(true);
    expect(canMoveTabsToPane).toHaveBeenCalledWith(
      [pinnedAgentTab.tabId, pinnedTerminalTab.tabId],
      "surviving",
    );
    expect(closeTabs).toHaveBeenCalledWith({
      tabsToClose: [unpinnedTab],
      title: "Close pane",
      logLabel: "from pane close",
    });
    expect(canMoveTabsToPane.mock.invocationCallOrder[0]).toBeLessThan(
      closeTabs.mock.invocationCallOrder[0],
    );
    expect(moveTabToPane).toHaveBeenNthCalledWith(1, pinnedAgentTab.tabId, "surviving");
    expect(moveTabToPane).toHaveBeenNthCalledWith(2, pinnedTerminalTab.tabId, "surviving");
    expect(closePane).toHaveBeenCalledWith("closing");
    expect(moveTabToPane.mock.invocationCallOrder[0]).toBeLessThan(
      closePane.mock.invocationCallOrder[0],
    );
  });

  it("blocks the final pane before any tab teardown", async () => {
    const pinnedTab = createTab(
      "file_/repo/pinned.ts",
      { kind: "file", path: "/repo/pinned.ts" },
      true,
    );
    const layout: WorkspaceLayout = {
      root: {
        kind: "pane",
        pane: {
          id: "main",
          tabIds: [pinnedTab.tabId],
          focusedTabId: pinnedTab.tabId,
        },
      },
      focusedPaneId: "main",
    };
    const canMoveTabsToPane = vi.fn(() => true);
    const closeTabs = vi.fn(async () => true);
    const moveTabToPane = vi.fn(() => true);
    const closePane = vi.fn();

    const closed = await executeCloseWorkspacePaneAction({
      layout,
      paneId: "main",
      explorerSidebarPaneId: null,
      tabsById: new Map([[pinnedTab.tabId, pinnedTab]]),
      title: "Close pane",
      canMoveTabsToPane,
      closeTabs,
      moveTabToPane,
      closePane,
    });

    expect(closed).toBe(false);
    expect(canMoveTabsToPane).not.toHaveBeenCalled();
    expect(closeTabs).not.toHaveBeenCalled();
    expect(moveTabToPane).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
  });

  it("does not tear down unpinned tabs when relocation preflight fails", async () => {
    const pinnedTab = createTab("changes_tree", { kind: "changes_tree" }, true);
    const unpinnedTab = createTab("file_/repo/temporary.ts", {
      kind: "file",
      path: "/repo/temporary.ts",
    });
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "root",
          direction: "horizontal",
          sizes: [0.25, 0.75],
          children: [
            {
              kind: "pane",
              pane: {
                id: "explorer",
                tabIds: [pinnedTab.tabId, unpinnedTab.tabId],
                focusedTabId: unpinnedTab.tabId,
              },
            },
            {
              kind: "pane",
              pane: { id: "main", tabIds: [], focusedTabId: null },
            },
          ],
        },
      },
      focusedPaneId: "explorer",
    };
    const canMoveTabsToPane = vi.fn(() => false);
    const closeTabs = vi.fn(async () => true);
    const moveTabToPane = vi.fn(() => true);
    const closePane = vi.fn();

    const closed = await executeCloseWorkspacePaneAction({
      layout,
      paneId: "explorer",
      explorerSidebarPaneId: "explorer",
      tabsById: new Map([
        [pinnedTab.tabId, pinnedTab],
        [unpinnedTab.tabId, unpinnedTab],
      ]),
      title: "Close pane",
      canMoveTabsToPane,
      closeTabs,
      moveTabToPane,
      closePane,
    });

    expect(closed).toBe(false);
    expect(canMoveTabsToPane).toHaveBeenCalledWith([pinnedTab.tabId], "main");
    expect(closeTabs).not.toHaveBeenCalled();
    expect(moveTabToPane).not.toHaveBeenCalled();
    expect(closePane).not.toHaveBeenCalled();
  });
});
