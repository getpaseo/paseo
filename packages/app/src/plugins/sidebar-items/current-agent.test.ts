import { describe, expect, it } from "vitest";
import { normalizeLayout } from "@/stores/workspace-layout-store";
import { getPluginSidebarCurrentAgentId } from "./current-agent";

const layout = normalizeLayout({
  focusedPaneId: "main",
  root: {
    kind: "pane",
    pane: {
      id: "main",
      tabIds: ["chat", "terminal"],
      focusedTabId: "chat",
      tabs: [
        { tabId: "chat", target: { kind: "agent", agentId: "agent-1" }, createdAt: 1 },
        { tabId: "terminal", target: { kind: "terminal", terminalId: "term-1" }, createdAt: 2 },
      ],
    },
  },
});

describe("plugin sidebar native conversation selection", () => {
  it("follows the focused workspace tab and clears on non-agent tabs", () => {
    expect(
      getPluginSidebarCurrentAgentId("host-1", "/h/host-1/workspace/ws-1", {
        "host-1:ws-1": layout,
      }),
    ).toBe("agent-1");
    const terminalLayout = structuredClone(layout);
    if (terminalLayout.root.kind !== "pane") throw new Error("Expected a pane");
    terminalLayout.root.pane.focusedTabId = "terminal";
    expect(
      getPluginSidebarCurrentAgentId("host-1", "/h/host-1/workspace/ws-1", {
        "host-1:ws-1": terminalLayout,
      }),
    ).toBeNull();
  });

  it("does not leak another host's or workspace's remembered selection", () => {
    const layouts = { "host-1:ws-1": layout };
    expect(
      getPluginSidebarCurrentAgentId("host-2", "/h/host-1/workspace/ws-1", layouts),
    ).toBeNull();
    expect(
      getPluginSidebarCurrentAgentId("host-1", "/h/host-1/workspace/ws-2", layouts),
    ).toBeNull();
    expect(
      getPluginSidebarCurrentAgentId("host-1", "/h/host-1/plugin/bots/surface/main", layouts),
    ).toBeNull();
    expect(getPluginSidebarCurrentAgentId("host-1", "/settings", layouts)).toBeNull();
  });

  it("handles direct agent deep links on the matching host", () => {
    expect(getPluginSidebarCurrentAgentId("host-1", "/h/host-1/agent/agent-2", {})).toBe("agent-2");
    expect(getPluginSidebarCurrentAgentId("host-2", "/h/host-1/agent/agent-2", {})).toBeNull();
  });
});
