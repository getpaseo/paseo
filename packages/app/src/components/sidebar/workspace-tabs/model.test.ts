import { describe, expect, it } from "vitest";
import {
  createWorkspaceLayoutWithExplorerSidebar,
  EXPLORER_SIDEBAR_PANE_ID,
  normalizeLayout,
} from "@/stores/workspace-layout-actions";
import type { SubagentRow } from "@/subagents/select";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  hasSidebarWorkspaceTabsDisclosure,
  selectNestedSubagentTabIds,
  selectSidebarWorkspaceTabs,
  summarizeSidebarWorkspaceTabs,
  toggleExpandedKey,
} from "./model";

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

describe("toggleExpandedKey", () => {
  it("expands a collapsed workspace and collapses an expanded one", () => {
    const expanded = toggleExpandedKey(new Set(), "server:a");
    expect([...expanded]).toEqual(["server:a"]);
    expect([...toggleExpandedKey(expanded, "server:a")]).toEqual([]);
  });
});

describe("hasSidebarWorkspaceTabsDisclosure", () => {
  it("offers the tabs only when there is more than one", () => {
    expect(hasSidebarWorkspaceTabsDisclosure(0)).toBe(false);
    expect(hasSidebarWorkspaceTabsDisclosure(1)).toBe(false);
    expect(hasSidebarWorkspaceTabsDisclosure(2)).toBe(true);
  });

  it("offers a lone agent tab when that agent has subagents to list", () => {
    expect(hasSidebarWorkspaceTabsDisclosure(1, true)).toBe(true);
    expect(hasSidebarWorkspaceTabsDisclosure(0, true)).toBe(false);
  });
});

describe("summarizeSidebarWorkspaceTabs", () => {
  const descriptor = (tabId: string, target: WorkspaceTabTarget) => ({
    key: tabId,
    tabId,
    kind: target.kind,
    target,
  });

  it("names the agent of a workspace's only tab", () => {
    const summary = summarizeSidebarWorkspaceTabs({
      tabs: [descriptor("agent_a", { kind: "agent", agentId: "a" })],
      activeTabId: "agent_a",
    });
    expect(summary).toEqual({ tabCount: 1, soleAgentId: "a" });
  });

  it("names no agent when the only tab is something else, or there are several", () => {
    expect(
      summarizeSidebarWorkspaceTabs({
        tabs: [descriptor("terminal_t", { kind: "terminal", terminalId: "t" })],
        activeTabId: null,
      }),
    ).toEqual({ tabCount: 1, soleAgentId: null });
    expect(
      summarizeSidebarWorkspaceTabs({
        tabs: [
          descriptor("agent_a", { kind: "agent", agentId: "a" }),
          descriptor("agent_b", { kind: "agent", agentId: "b" }),
        ],
        activeTabId: null,
      }),
    ).toEqual({ tabCount: 2, soleAgentId: null });
  });
});

describe("selectNestedSubagentTabIds", () => {
  const descriptor = (tabId: string, target: WorkspaceTabTarget) => ({
    key: tabId,
    tabId,
    kind: target.kind,
    target,
  });
  const paseoChild = (id: string) =>
    ({ kind: "paseo", id, address: { serverId: "s", agentId: id } }) as SubagentRow;
  const providerChild = (parentAgentId: string, id: string) =>
    ({ kind: "provider", id, parentAgentId }) as SubagentRow;

  const parent = descriptor("agent_p", { kind: "agent", agentId: "p" });
  const child = descriptor("agent_c", { kind: "agent", agentId: "c" });
  const providerTab = descriptor("ps_x", {
    kind: "provider_subagent",
    parentAgentId: "p",
    subagentId: "x",
  });
  const terminal = descriptor("terminal_t", { kind: "terminal", terminalId: "t" });

  it("nests the tabs of children their parent's list shows", () => {
    const rows: Record<string, SubagentRow[]> = {
      p: [paseoChild("c"), providerChild("p", "x")],
    };
    expect(
      selectNestedSubagentTabIds([parent, child, providerTab, terminal], (id) => rows[id] ?? []),
    ).toEqual(["agent_c", "ps_x"]);
  });

  it("keeps a child at the top level when its parent has no tab or does not list it", () => {
    expect(selectNestedSubagentTabIds([child, providerTab], () => [paseoChild("c")])).toEqual([]);
    expect(selectNestedSubagentTabIds([parent, child], () => [])).toEqual([]);
  });
});
