import React, { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { Text } from "react-native";
import { afterEach, expect, it, vi } from "vitest";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import { WorkspacePanelHost } from "@/screens/workspace/workspace-panel-host";
import type { WorkspacePaneContentModel } from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

vi.stubGlobal("React", React);
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
const mountCounts = new Map<string, number>();
const focusPaneByTabId = new Map<string, () => void>();
const HOST_FRAME_STYLE = { position: "relative", height: 400, display: "flex" } as const;
afterEach(() => {
  act(() => root.render(null));
  mountCounts.clear();
  focusPaneByTabId.clear();
});

function ProbePanel() {
  const { tabId } = usePaneContext();
  const { isInteractive, focusPane } = usePaneFocus();
  focusPaneByTabId.set(tabId, focusPane);
  useEffect(() => {
    mountCounts.set(tabId, (mountCounts.get(tabId) ?? 0) + 1);
  }, [tabId]);
  return <Text testID={`probe-${tabId}`}>{isInteractive ? "interactive" : "inert"}</Text>;
}

function terminalTab(tabId: string): WorkspaceTabDescriptor {
  const target = { kind: "terminal" as const, terminalId: tabId };
  return { key: tabId, tabId, kind: "terminal", target };
}

function buildPaneContentModel(input: {
  paneId: string;
  tab: WorkspaceTabDescriptor;
}): WorkspacePaneContentModel {
  return {
    key: input.tab.tabId,
    Component: ProbePanel,
    paneContextValue: {
      serverId: "server",
      workspaceId: "workspace",
      host: "explorer",
      tabId: input.tab.tabId,
      target: input.tab.target,
      openTab: () => undefined,
      openPreferredTarget: () => undefined,
      closeCurrentTab: () => undefined,
      retargetCurrentTab: () => undefined,
      setCurrentTabState: () => undefined,
      openFileInWorkspace: () => undefined,
      openImportSheet: () => undefined,
    },
  };
}

function probe(tabId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="probe-${tabId}"]`);
}

function isShown(tabId: string): boolean {
  const element = probe(tabId);
  return element !== null && element.offsetParent !== null;
}

it("without a split, mounts recent tabs, shows only the active one, and makes it interactive only when the pane is focused", () => {
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3"), terminalTab("t4")];
  const render = (activeTabId: string, isPaneFocused: boolean) =>
    act(() =>
      root.render(
        <WorkspacePanelHost
          paneId="explorer"
          tabs={tabs}
          activeTabId={activeTabId}
          normalizedServerId="server"
          normalizedWorkspaceId="workspace"
          isWorkspaceFocused
          isPaneFocused={isPaneFocused}
          buildPaneContentModel={buildPaneContentModel}
        />,
      ),
    );

  render("t1", true);
  render("t2", true);
  render("t3", true);

  expect(probe("t1")).not.toBeNull();
  expect(probe("t2")).not.toBeNull();
  expect(probe("t3")).not.toBeNull();
  expect(probe("t4")).toBeNull();
  expect(isShown("t3")).toBe(true);
  expect(isShown("t1")).toBe(false);
  expect(isShown("t2")).toBe(false);
  expect(probe("t3")?.textContent).toBe("interactive");
  expect(probe("t2")?.textContent).toBe("inert");

  render("t3", false);

  expect(probe("t3")?.textContent).toBe("inert");
});

function renderHost(input: {
  tabs: WorkspaceTabDescriptor[];
  activeTabId: string;
  split?: {
    lowerTabId: string;
    activeSlot: "top" | "bottom";
    ratio: number;
    containerHeight: number;
    lowerHeaderHeight: number;
    onFocusSlot: (slot: "top" | "bottom") => void;
  };
}) {
  act(() =>
    root.render(
      <div style={HOST_FRAME_STYLE}>
        <WorkspacePanelHost
          paneId="explorer"
          tabs={input.tabs}
          activeTabId={input.activeTabId}
          normalizedServerId="server"
          normalizedWorkspaceId="workspace"
          isWorkspaceFocused
          isPaneFocused
          buildPaneContentModel={buildPaneContentModel}
          split={input.split}
        />
      </div>,
    ),
  );
}

it("with a split, mounts and shows the bottom tab even when the recent-tab cap would drop it", () => {
  const tabs = [
    terminalTab("t1"),
    terminalTab("t2"),
    terminalTab("t3"),
    terminalTab("t4"),
    terminalTab("t5"),
  ];
  renderHost({ tabs, activeTabId: "t2" });
  renderHost({ tabs, activeTabId: "t3" });
  renderHost({ tabs, activeTabId: "t4" });
  expect(probe("t1")).toBeNull();

  renderHost({
    tabs,
    activeTabId: "t4",
    split: {
      lowerTabId: "t1",
      activeSlot: "top",
      ratio: 0.5,
      containerHeight: 400,
      lowerHeaderHeight: 28,
      onFocusSlot: () => undefined,
    },
  });

  expect(isShown("t4")).toBe(true);
  expect(isShown("t1")).toBe(true);
});

function panelBox(tabId: string): { top: number; height: number } {
  const wrapper = container.firstElementChild as HTMLElement;
  const panel = [...wrapper.children].find((child) => child.contains(probe(tabId)));
  const wrapperTop = wrapper.getBoundingClientRect().top;
  const rect = (panel as HTMLElement).getBoundingClientRect();
  return { top: rect.top - wrapperTop, height: rect.height };
}

it("places the top tab above the ratio line and the bottom tab below the bottom header", () => {
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];

  renderHost({
    tabs,
    activeTabId: "t2",
    split: {
      lowerTabId: "t3",
      activeSlot: "top",
      ratio: 0.25,
      containerHeight: 400,
      lowerHeaderHeight: 28,
      onFocusSlot: () => undefined,
    },
  });

  expect(panelBox("t2")).toEqual({ top: 0, height: 100 });
  expect(panelBox("t3")).toEqual({ top: 128, height: 272 });
});

it("makes only the active slot's tab interactive, and follows the active slot when it changes", () => {
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
  const split = {
    lowerTabId: "t3",
    ratio: 0.5,
    containerHeight: 400,
    lowerHeaderHeight: 28,
    onFocusSlot: () => undefined,
  };

  renderHost({ tabs, activeTabId: "t2", split: { ...split, activeSlot: "top" } });

  expect(probe("t2")?.textContent).toBe("interactive");
  expect(probe("t3")?.textContent).toBe("inert");

  renderHost({ tabs, activeTabId: "t2", split: { ...split, activeSlot: "bottom" } });

  expect(probe("t2")?.textContent).toBe("inert");
  expect(probe("t3")?.textContent).toBe("interactive");
});

function slotOf(tabId: string): string | null {
  const panel = probe(tabId)?.closest("[data-explorer-slot]");
  return panel ? panel.getAttribute("data-explorer-slot") : null;
}

it("marks the two visible tabs with their slot and leaves hidden tabs unmarked", () => {
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
  renderHost({ tabs, activeTabId: "t1" });

  renderHost({
    tabs,
    activeTabId: "t2",
    split: {
      lowerTabId: "t3",
      activeSlot: "top",
      ratio: 0.5,
      containerHeight: 400,
      lowerHeaderHeight: 28,
      onFocusSlot: () => undefined,
    },
  });

  expect(probe("t1")).not.toBeNull();
  expect(slotOf("t1")).toBeNull();
  expect(slotOf("t2")).toBe("top");
  expect(slotOf("t3")).toBe("bottom");
});

it("reports a panel's own focus request as a focus of the slot it sits in", () => {
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
  const focusedSlots: string[] = [];

  renderHost({
    tabs,
    activeTabId: "t2",
    split: {
      lowerTabId: "t3",
      activeSlot: "top",
      ratio: 0.5,
      containerHeight: 400,
      lowerHeaderHeight: 28,
      onFocusSlot: (slot) => focusedSlots.push(slot),
    },
  });
  act(() => focusPaneByTabId.get("t3")?.());
  act(() => focusPaneByTabId.get("t2")?.());

  expect(focusedSlots).toEqual(["bottom", "top"]);
});

function panelElement(tabId: string): Element | undefined {
  const wrapper = container.firstElementChild as HTMLElement;
  return [...wrapper.children].find((child) => child.contains(probe(tabId)));
}

function panelIndex(tabId: string): number {
  const wrapper = container.firstElementChild as HTMLElement;
  return [...wrapper.children].findIndex((child) => child.contains(probe(tabId)));
}

it("swaps the two tabs between slots without remounting or moving either panel", () => {
  const tabs = [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")];
  const split = {
    activeSlot: "top" as const,
    ratio: 0.25,
    containerHeight: 400,
    lowerHeaderHeight: 28,
    onFocusSlot: () => undefined,
  };
  renderHost({ tabs, activeTabId: "t2", split: { ...split, lowerTabId: "t3" } });
  const t2Panel = panelElement("t2");
  const t3Panel = panelElement("t3");
  const t2Index = panelIndex("t2");
  const t3Index = panelIndex("t3");

  renderHost({ tabs, activeTabId: "t3", split: { ...split, lowerTabId: "t2" } });

  expect(mountCounts.get("t2")).toBe(1);
  expect(mountCounts.get("t3")).toBe(1);
  expect(panelElement("t2")).toBe(t2Panel);
  expect(panelElement("t3")).toBe(t3Panel);
  expect(panelIndex("t2")).toBe(t2Index);
  expect(panelIndex("t3")).toBe(t3Index);
  expect(panelBox("t3")).toEqual({ top: 0, height: 100 });
  expect(panelBox("t2")).toEqual({ top: 128, height: 272 });
});

it("keeps both visible panels mounted when the tabs are reordered while split", () => {
  const split = {
    lowerTabId: "t3",
    activeSlot: "top" as const,
    ratio: 0.5,
    containerHeight: 400,
    lowerHeaderHeight: 28,
    onFocusSlot: () => undefined,
  };
  renderHost({
    tabs: [terminalTab("t1"), terminalTab("t2"), terminalTab("t3")],
    activeTabId: "t2",
    split,
  });
  const t2Panel = panelElement("t2");
  const t3Panel = panelElement("t3");

  renderHost({
    tabs: [terminalTab("t3"), terminalTab("t1"), terminalTab("t2")],
    activeTabId: "t2",
    split,
  });

  expect(mountCounts.get("t2")).toBe(1);
  expect(mountCounts.get("t3")).toBe(1);
  expect(panelElement("t2")).toBe(t2Panel);
  expect(panelElement("t3")).toBe(t3Panel);
});

it("refuses a split whose bottom tab is the active tab", () => {
  expect(() =>
    renderHost({
      tabs: [terminalTab("t1"), terminalTab("t2")],
      activeTabId: "t2",
      split: {
        lowerTabId: "t2",
        activeSlot: "top",
        ratio: 0.5,
        containerHeight: 400,
        lowerHeaderHeight: 28,
        onFocusSlot: () => undefined,
      },
    }),
  ).toThrow("Explorer split bottom tab t2 is the active tab");
});

it("refuses a split whose bottom tab is not among the host's tabs", () => {
  expect(() =>
    renderHost({
      tabs: [terminalTab("t1"), terminalTab("t2")],
      activeTabId: "t2",
      split: {
        lowerTabId: "gone",
        activeSlot: "top",
        ratio: 0.5,
        containerHeight: 400,
        lowerHeaderHeight: 28,
        onFocusSlot: () => undefined,
      },
    }),
  ).toThrow("Explorer split bottom tab gone is not among the host's tabs");
});
