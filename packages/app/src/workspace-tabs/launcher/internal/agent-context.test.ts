import { describe, expect, it } from "vitest";
import { normalizeLayout, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { resolveLauncherAgentId } from "./agent-context";

function agentTab(tabId: string, agentId: string, createdAt: number): WorkspaceTab {
  return { tabId, target: { kind: "agent", agentId }, createdAt };
}

function newTab(tabId: string, createdAt = 1): WorkspaceTab {
  return { tabId, target: { kind: "new_tab" }, createdAt };
}

function singlePane(tabs: WorkspaceTab[], focusedTabId: string | null): WorkspaceLayout {
  return normalizeLayout({
    focusedPaneId: "main",
    root: {
      kind: "pane",
      pane: { id: "main", tabIds: tabs.map((tab) => tab.tabId), focusedTabId, tabs },
    },
  });
}

function twoPanes(input: {
  left: { tabs: WorkspaceTab[]; focusedTabId: string | null };
  right: { tabs: WorkspaceTab[]; focusedTabId: string | null };
  focusedPaneId: string;
}): WorkspaceLayout {
  return normalizeLayout({
    focusedPaneId: input.focusedPaneId,
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
              id: "left",
              tabIds: input.left.tabs.map((tab) => tab.tabId),
              focusedTabId: input.left.focusedTabId,
              tabs: input.left.tabs,
            },
          },
          {
            kind: "pane",
            pane: {
              id: "right",
              tabIds: input.right.tabs.map((tab) => tab.tabId),
              focusedTabId: input.right.focusedTabId,
              tabs: input.right.tabs,
            },
          },
        ],
      },
    },
  });
}

describe("resolveLauncherAgentId", () => {
  it("prefers the focused tab's agent", () => {
    const layout = twoPanes({
      left: { tabs: [agentTab("a", "agent-left", 1)], focusedTabId: "a" },
      right: { tabs: [agentTab("b", "agent-right", 2)], focusedTabId: "b" },
      focusedPaneId: "left",
    });
    expect(resolveLauncherAgentId(layout)).toBe("agent-left");
  });

  it("keeps agent context while an agent-context plugin panel is focused", () => {
    const layout = singlePane(
      [
        {
          tabId: "panel",
          target: {
            kind: "plugin",
            pluginId: "skills",
            panelId: "skills",
            context: "agent",
            agentId: "agent-1",
          },
          createdAt: 1,
        },
      ],
      "panel",
    );
    expect(resolveLauncherAgentId(layout)).toBe("agent-1");
  });

  it("falls back to a visible agent when the launching pane holds the New tab", () => {
    const layout = twoPanes({
      left: { tabs: [newTab("blank")], focusedTabId: "blank" },
      right: { tabs: [agentTab("b", "agent-right", 2)], focusedTabId: "b" },
      focusedPaneId: "left",
    });
    expect(resolveLauncherAgentId(layout)).toBe("agent-right");
  });

  it("prefers a visible agent over a newer background one", () => {
    const layout = twoPanes({
      left: { tabs: [newTab("blank")], focusedTabId: "blank" },
      right: {
        tabs: [agentTab("shown", "agent-shown", 1), agentTab("hidden", "agent-hidden", 9)],
        focusedTabId: "shown",
      },
      focusedPaneId: "left",
    });
    expect(resolveLauncherAgentId(layout)).toBe("agent-shown");
  });

  it("falls back to the newest background agent when none is visible", () => {
    const layout = singlePane(
      [newTab("blank"), agentTab("old", "agent-old", 1), agentTab("new", "agent-new", 5)],
      "blank",
    );
    expect(resolveLauncherAgentId(layout)).toBe("agent-new");
  });

  it("returns null when the workspace has no agent", () => {
    expect(resolveLauncherAgentId(singlePane([newTab("blank")], "blank"))).toBeNull();
  });

  it("returns null without a layout", () => {
    expect(resolveLauncherAgentId(null)).toBeNull();
  });
});
