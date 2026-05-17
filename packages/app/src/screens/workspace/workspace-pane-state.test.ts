import { describe, expect, it } from "vitest";
import {
  deriveWorkspacePaneState,
  getWorkspacePaneDescriptors,
  resolveSideFileOpenPlacement,
} from "@/screens/workspace/workspace-pane-state";
import type { WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/stores/workspace-tabs-store";

function createTab(tabId: string, target: WorkspaceTab["target"]): WorkspaceTab {
  return {
    tabId,
    target,
    createdAt: 1,
  };
}

describe("workspace-pane-state", () => {
  it("selects the focused pane and keeps its tab order", () => {
    const tabs: WorkspaceTab[] = [
      createTab("agent_agent-a", { kind: "agent", agentId: "agent-a" }),
      createTab("file_/repo/README.md", { kind: "file", path: "/repo/README.md" }),
      createTab("terminal_term-1", { kind: "terminal", terminalId: "term-1" }),
    ];
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "group-root",
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            {
              kind: "pane",
              pane: {
                id: "left",
                tabIds: ["file_/repo/README.md", "agent_agent-a"],
                focusedTabId: "agent_agent-a",
              },
            },
            {
              kind: "pane",
              pane: {
                id: "right",
                tabIds: ["terminal_term-1"],
                focusedTabId: "terminal_term-1",
              },
            },
          ],
        },
      },
      focusedPaneId: "left",
    };

    const state = deriveWorkspacePaneState({ layout, tabs });

    expect(state.pane?.id).toBe("left");
    expect(state.tabs.map((tab) => tab.descriptor.tabId)).toEqual([
      "file_/repo/README.md",
      "agent_agent-a",
    ]);
    expect(state.activeTabId).toBe("agent_agent-a");
  });

  it("falls back to the first ordered pane tab when focusedTabId is empty", () => {
    const pane = {
      id: "main",
      tabIds: ["draft_1", "draft_2"],
      focusedTabId: " ",
    };
    const tabs: WorkspaceTab[] = [
      createTab("draft_2", { kind: "draft", draftId: "draft_2" }),
      createTab("draft_1", { kind: "draft", draftId: "draft_1" }),
    ];

    const state = deriveWorkspacePaneState({ pane, tabs });

    expect(state.activeTabId).toBe("draft_1");
    expect(getWorkspacePaneDescriptors({ pane, tabs }).map((tab) => tab.tabId)).toEqual([
      "draft_1",
      "draft_2",
    ]);
  });

  it("prefers a matching target over stale focused tab state", () => {
    const pane = {
      id: "main",
      tabIds: ["agent_agent-a", "file_/repo/README.md"],
      focusedTabId: "agent_agent-a",
    };
    const tabs: WorkspaceTab[] = [
      createTab("agent_agent-a", { kind: "agent", agentId: "agent-a" }),
      createTab("file_/repo/README.md", { kind: "file", path: "/repo/README.md" }),
    ];

    const state = deriveWorkspacePaneState({
      pane,
      tabs,
      preferredTarget: { kind: "file", path: "\\repo\\README.md" },
    });

    expect(state.activeTabId).toBe("file_/repo/README.md");
    expect(state.activeTab?.descriptor.target).toEqual({
      kind: "file",
      path: "/repo/README.md",
    });
  });

  it("resolves side file opens to an existing file tab", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "pane",
        pane: {
          id: "main",
          tabIds: ["file_/repo/README.md"],
          focusedTabId: "file_/repo/README.md",
        },
      },
      focusedPaneId: "main",
    };
    const tabs = [createTab("file_/repo/README.md", { kind: "file", path: "/repo/README.md" })];

    expect(
      resolveSideFileOpenPlacement({
        layout,
        sourcePaneId: "main",
        tabs,
        target: { kind: "file", path: "/repo/README.md" },
      }),
    ).toEqual({ kind: "open-in-source" });
  });

  it("resolves side file opens to an existing file tab when only the line range differs", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "pane",
        pane: {
          id: "main",
          tabIds: ["file_/repo/README.md"],
          focusedTabId: "file_/repo/README.md",
        },
      },
      focusedPaneId: "main",
    };
    const tabs = [createTab("file_/repo/README.md", { kind: "file", path: "/repo/README.md" })];

    expect(
      resolveSideFileOpenPlacement({
        layout,
        sourcePaneId: "main",
        tabs,
        target: { kind: "file", path: "/repo/README.md", lineStart: 12, lineEnd: 20 },
      }),
    ).toEqual({ kind: "open-in-source" });
  });

  it("resolves side file opens to an existing right pane", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "group",
        group: {
          id: "group-root",
          direction: "horizontal",
          sizes: [0.5, 0.5],
          children: [
            {
              kind: "pane",
              pane: { id: "left", tabIds: ["agent_agent-a"], focusedTabId: "agent_agent-a" },
            },
            {
              kind: "pane",
              pane: { id: "right", tabIds: [], focusedTabId: null },
            },
          ],
        },
      },
      focusedPaneId: "left",
    };

    expect(
      resolveSideFileOpenPlacement({
        layout,
        sourcePaneId: "left",
        tabs: [createTab("agent_agent-a", { kind: "agent", agentId: "agent-a" })],
        target: { kind: "file", path: "/repo/README.md" },
      }),
    ).toEqual({ kind: "focus-side-pane", paneId: "right" });
  });

  it("resolves side file opens to a split when there is no right pane", () => {
    const layout: WorkspaceLayout = {
      root: {
        kind: "pane",
        pane: { id: "main", tabIds: ["agent_agent-a"], focusedTabId: "agent_agent-a" },
      },
      focusedPaneId: "main",
    };

    expect(
      resolveSideFileOpenPlacement({
        layout,
        sourcePaneId: "main",
        tabs: [createTab("agent_agent-a", { kind: "agent", agentId: "agent-a" })],
        target: { kind: "file", path: "/repo/README.md" },
      }),
    ).toEqual({ kind: "split-side-pane", paneId: "main" });
  });
});
