import { describe, expect, it } from "vitest";
import { normalizeLayout, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { resolveLauncherAgentCandidates, resolveLauncherAgentId } from "./agent-context";

function agentTab(tabId: string, agentId: string, createdAt: number): WorkspaceTab {
  return { tabId, target: { kind: "agent", agentId }, createdAt };
}

function newTab(tabId: string, createdAt = 1): WorkspaceTab {
  return { tabId, target: { kind: "new_tab" }, createdAt };
}

function pane(id: string, tabs: WorkspaceTab[], focusedTabId: string | null) {
  return { kind: "pane", pane: { id, focusedTabId, tabs } };
}

function singlePane(tabs: WorkspaceTab[], focusedTabId: string | null): WorkspaceLayout {
  return normalizeLayout({ focusedPaneId: "main", root: pane("main", tabs, focusedTabId) });
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
          pane("left", input.left.tabs, input.left.focusedTabId),
          pane("right", input.right.tabs, input.right.focusedTabId),
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

  it("prefers the launching pane's agent over the focused pane's", () => {
    const layout = twoPanes({
      left: { tabs: [agentTab("a", "agent-left", 1)], focusedTabId: "a" },
      right: { tabs: [agentTab("b", "agent-right", 2)], focusedTabId: "b" },
      focusedPaneId: "left",
    });
    expect(resolveLauncherAgentId(layout, { origin: { paneId: "right" } })).toBe("agent-right");
  });

  it("resolves the launching pane from the replaced tab", () => {
    const layout = twoPanes({
      left: { tabs: [agentTab("a", "agent-left", 1)], focusedTabId: "a" },
      right: { tabs: [newTab("blank"), agentTab("b", "agent-right", 2)], focusedTabId: "b" },
      focusedPaneId: "left",
    });
    expect(resolveLauncherAgentId(layout, { origin: { tabId: "blank" } })).toBe("agent-right");
  });

  it("skips ineligible candidates instead of returning null", () => {
    const layout = twoPanes({
      left: { tabs: [agentTab("stale", "agent-gone", 9)], focusedTabId: "stale" },
      right: { tabs: [agentTab("live", "agent-live", 1)], focusedTabId: "live" },
      focusedPaneId: "left",
    });
    expect(
      resolveLauncherAgentId(layout, { isEligible: (agentId) => agentId !== "agent-gone" }),
    ).toBe("agent-live");
  });

  it("returns null when no candidate is eligible", () => {
    const layout = singlePane([agentTab("a", "agent-gone", 1)], "a");
    expect(resolveLauncherAgentId(layout, { isEligible: () => false })).toBeNull();
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

  it("resolves a focused subagent tab to its parent agent", () => {
    const layout = singlePane(
      [
        {
          tabId: "sub",
          target: { kind: "provider_subagent", parentAgentId: "agent-1", subagentId: "sub-1" },
          createdAt: 5,
        },
        agentTab("other", "agent-2", 9),
      ],
      "sub",
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

describe("resolveLauncherAgentCandidates", () => {
  it("orders candidates launching pane first, then focused, visible, newest", () => {
    const layout = twoPanes({
      left: {
        tabs: [agentTab("a", "agent-left", 1), agentTab("bg", "agent-background", 9)],
        focusedTabId: "a",
      },
      right: { tabs: [agentTab("b", "agent-right", 2)], focusedTabId: "b" },
      focusedPaneId: "left",
    });
    expect(resolveLauncherAgentCandidates(layout, { paneId: "right" })).toEqual([
      "agent-right",
      "agent-left",
      "agent-background",
    ]);
  });
});
