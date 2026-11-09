import { describe, expect, it } from "vitest";
import {
  createWorkspaceLayoutWithExplorerSidebar,
  EXPLORER_SIDEBAR_PANE_ID,
  normalizeLayout,
} from "@/stores/workspace-layout-actions";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { selectSidebarWorkspaceTabs, toggleExpandedWorkspaceKey } from "./model";

function tab(tabId: string, target: WorkspaceTabTarget) {
  return { tabId, target, createdAt: 1 };
}

function pane(input: {
  id: string;
  tabs: ReturnType<typeof tab>[];
  focusedTabId: string;
  hidden?: boolean;
}) {
  return { kind: "pane", pane: { ...input, tabIds: input.tabs.map((entry) => entry.tabId) } };
}

const agentTab = tab("agent_a", { kind: "agent", agentId: "a" });
const terminalTab = tab("terminal_t", { kind: "terminal", terminalId: "t" });
const fileTab = tab("file_f", { kind: "file", path: "src/index.ts" });
const filesTab = tab("files", { kind: "files" });

function splitLayout(focusedPaneId: string) {
  return normalizeLayout({
    root: {
      kind: "group",
      group: {
        id: "root",
        direction: "horizontal",
        sizes: [0.4, 0.4, 0.2],
        children: [
          pane({ id: "left", tabs: [agentTab, terminalTab], focusedTabId: "terminal_t" }),
          pane({ id: "right", tabs: [fileTab], focusedTabId: "file_f" }),
          pane({ id: EXPLORER_SIDEBAR_PANE_ID, tabs: [filesTab], focusedTabId: "files" }),
        ],
      },
    },
    focusedPaneId,
  });
}

describe("selectSidebarWorkspaceTabs", () => {
  it("has no tabs for a workspace that was never opened", () => {
    expect(selectSidebarWorkspaceTabs({ layout: null, explorerPaneId: null })).toEqual({
      tabs: [],
      activeTabId: null,
    });
  });

  it("lists every pane's tabs in pane order and marks the focused pane's tab", () => {
    const result = selectSidebarWorkspaceTabs({
      layout: splitLayout("left"),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });

    expect(result.tabs.map((entry) => entry.tabId)).toEqual(["agent_a", "terminal_t", "file_f"]);
    expect(result.tabs[0]).toMatchObject({
      key: "agent_a",
      kind: "agent",
      target: agentTab.target,
    });
    expect(result.activeTabId).toBe("terminal_t");
  });

  it("follows pane focus to another pane", () => {
    const result = selectSidebarWorkspaceTabs({
      layout: splitLayout("right"),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });

    expect(result.activeTabId).toBe("file_f");
  });

  it("leaves out the explorer, so its Files and Changes do not show under every workspace", () => {
    const result = selectSidebarWorkspaceTabs({
      layout: createWorkspaceLayoutWithExplorerSidebar(),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });

    expect(result.tabs.map((entry) => entry.kind)).toEqual(["new_tab"]);
  });

  it("has no active tab while the explorer holds focus", () => {
    const result = selectSidebarWorkspaceTabs({
      layout: splitLayout(EXPLORER_SIDEBAR_PANE_ID),
      explorerPaneId: EXPLORER_SIDEBAR_PANE_ID,
    });

    expect(result.tabs).toHaveLength(3);
    expect(result.activeTabId).toBeNull();
  });
});

describe("toggleExpandedWorkspaceKey", () => {
  it("expands a collapsed workspace and collapses an expanded one", () => {
    const expanded = toggleExpandedWorkspaceKey(new Set(), "server:a");
    expect([...expanded]).toEqual(["server:a"]);
    expect([...toggleExpandedWorkspaceKey(expanded, "server:a")]).toEqual([]);
  });
});
