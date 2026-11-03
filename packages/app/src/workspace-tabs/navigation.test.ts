import { beforeEach, expect, it } from "vitest";
import {
  selectIsExplorerSidebarVisible,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { revealWorkspaceTab } from "./navigation";
import { openWorkspaceTargetAtLocation } from "./open-beside";

const workspaceKey = "server:workspace";
beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "split-panes",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
  });
  usePanelStore.getState().showMobileFileExplorer();
});
it("reveals an existing main file selected from compact Explorer", () => {
  const store = useWorkspaceLayoutStore.getState();
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "file", path: "existing.ts" },
    intent: "reveal",
  });
  store.setLayoutMode("compact");
  const existing = openWorkspaceTargetAtLocation({
    workspaceKey,
    target: { kind: "file", path: "existing.ts" },
    location: "main",
  });
  expect(existing).toBe(tabId);
  expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
});
it("keeps Explorer beneath a new compact file sheet", () => {
  const store = useWorkspaceLayoutStore.getState();
  store.setLayoutMode("compact");
  const tabId = openWorkspaceTargetAtLocation({
    workspaceKey,
    target: { kind: "file", path: "new.ts" },
    location: "main",
  });
  expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]?.[0].tab.tabId).toBe(
    tabId,
  );
});
it("reveals an explicit Explorer target and preserves the surface after a failed open", () => {
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.showExplorerSidebar(workspaceKey)!;
  store.setLayoutMode("compact");
  usePanelStore.getState().showMobileAgent();
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "file", path: "draft.ts" },
    intent: "reveal",
    placement: { mode: "pane", paneId },
  });
  revealWorkspaceTab(workspaceKey, tabId);
  expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  revealWorkspaceTab(workspaceKey, null);
  revealWorkspaceTab(workspaceKey, "missing");
  expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
});
it("preserves dock visibility intent while compact targets are opened and revealed", () => {
  const store = useWorkspaceLayoutStore.getState();
  const paneId = store.showExplorerSidebar(workspaceKey)!;
  store.hideExplorerSidebar(workspaceKey);
  store.setLayoutMode("compact");
  store.showExplorerSidebar(workspaceKey);
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "file", path: "overlay-only.ts" },
    intent: "reveal",
    placement: { mode: "pane", paneId },
  });
  revealWorkspaceTab(workspaceKey, tabId);
  store.setLayoutMode("split-panes");
  expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey].root).toBeDefined();
  expect(useWorkspaceLayoutStore.getState().getTabDestination(workspaceKey, tabId!)).toMatchObject({
    host: "explorer",
  });
  expect(selectIsExplorerSidebarVisible(useWorkspaceLayoutStore.getState(), workspaceKey)).toBe(
    false,
  );
});
it.each(["agent-list", "file-explorer"] as const)(
  "preserves %s under a deferred file sheet and reveals deferred agents",
  (panel) => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("compact");
    if (panel === "agent-list") usePanelStore.getState().showMobileAgentList();
    const before = usePanelStore.getState().mobilePanel;
    store.deferOpenTab({
      workspaceKey,
      target: { kind: "file", path: "pending.ts" },
      intent: "reveal",
    });
    revealWorkspaceTab(workspaceKey, store.consumePendingOpen(workspaceKey));
    expect(usePanelStore.getState().mobilePanel).toEqual(before);
    store.deferOpenTab({
      workspaceKey,
      target: { kind: "agent", agentId: "root" },
      intent: "reveal",
    });
    revealWorkspaceTab(workspaceKey, store.consumePendingOpen(workspaceKey));
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  },
);
