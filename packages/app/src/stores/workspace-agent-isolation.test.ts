import { describe, expect, it } from "vitest";
import {
  collectAllTabs,
  normalizeLayout,
  reconcileWorkspaceTabs,
  type WorkspaceTabSnapshot,
} from "./workspace-layout-actions";

function pinnedState() {
  return {
    layout: normalizeLayout({
      root: {
        kind: "pane",
        pane: {
          id: "main",
          tabs: [
            { tabId: "agent_foreign", target: { kind: "agent", agentId: "foreign" }, createdAt: 1 },
            {
              tabId: "file_readme",
              target: { kind: "file", path: "/repo/README.md" },
              createdAt: 2,
            },
          ],
          focusedTabId: "agent_foreign",
        },
      },
      focusedPaneId: "main",
    }),
    pinnedAgentIds: new Set(["foreign"]),
    explorerSidebarPaneId: null,
  };
}

const snapshot: WorkspaceTabSnapshot = {
  agentsHydrated: true,
  terminalsHydrated: true,
  activeAgentIds: ["own"],
  autoOpenAgentIds: ["own"],
  standaloneTerminalIds: [],
};

describe("workspace agent ownership", () => {
  it("removes foreign pinned tabs and preserves workspace files across repeated reconciliation", () => {
    const input = pinnedState();
    const foreignSnapshot = { ...snapshot, otherWorkspaceAgentIds: ["foreign"] };
    const first = reconcileWorkspaceTabs(input, foreignSnapshot);
    const next = reconcileWorkspaceTabs(first, foreignSnapshot);
    expect(collectAllTabs(next.layout.root).map((tab) => tab.target)).toEqual([
      { kind: "file", path: "/repo/README.md" },
      { kind: "agent", agentId: "own" },
    ]);
    expect(next.pinnedAgentIds).toEqual(new Set());
  });

  it("keeps an explicitly opened agent while its ownership is unknown", () => {
    const next = reconcileWorkspaceTabs(pinnedState(), snapshot);
    expect(collectAllTabs(next.layout.root).map((tab) => tab.target)).toContainEqual({
      kind: "agent",
      agentId: "foreign",
    });
  });

  it("keeps an explicitly opened archived agent belonging to this workspace", () => {
    const next = reconcileWorkspaceTabs(pinnedState(), {
      ...snapshot,
      otherWorkspaceAgentIds: ["another-workspace-agent"],
    });
    expect(collectAllTabs(next.layout.root).map((tab) => tab.target)).toContainEqual({
      kind: "agent",
      agentId: "foreign",
    });
  });
});
