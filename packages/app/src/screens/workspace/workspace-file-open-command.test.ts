import { beforeEach, describe, expect, it } from "vitest";
import { openWorkspaceFileFromExplorer } from "./workspace-file-open-command";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePanelStore } from "@/stores/panel-store";
import { revealWorkspaceTab } from "@/workspace-tabs/navigation";

const workspaceKey = "server:workspace";
function openFile(filePath: string, persistenceKey: string | null = workspaceKey) {
  openWorkspaceFileFromExplorer({
    filePath,
    persistenceKey,
    openWorkspaceTabInFocusedPane: (key, target, placement) =>
      useWorkspaceLayoutStore
        .getState()
        .openTab({ workspaceKey: key, target, placement, intent: "reveal" }),
    revealWorkspaceTab,
  });
}
beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutMode: "compact",
    layoutByWorkspace: {},
    sheetsByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
  });
  usePanelStore.getState().showMobileFileExplorer();
});
describe("file search destination", () => {
  it("preserves Explorer under a new file sheet", () => {
    openFile("new.ts");
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(useWorkspaceLayoutStore.getState().sheetsByWorkspace[workspaceKey]).toHaveLength(1);
  });
  it.each([null, workspaceKey])("preserves context when no file opens (%s)", (key) => {
    openFile("", key);
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  });
  it("reveals an existing main tab", () => {
    const store = useWorkspaceLayoutStore.getState();
    store.setLayoutMode("split-panes");
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "existing.ts" },
      intent: "reveal",
    });
    store.setLayoutMode("compact");
    openFile("existing.ts");
    expect(usePanelStore.getState().mobilePanel.target).toBe("agent");
  });
  it("reveals the existing Explorer tab from the left sidebar", () => {
    const store = useWorkspaceLayoutStore.getState();
    const paneId = store.showExplorerSidebar(workspaceKey)!;
    store.openTab({
      workspaceKey,
      target: { kind: "file", path: "existing.ts" },
      intent: "reveal",
      placement: { mode: "pane", paneId },
    });
    usePanelStore.getState().showMobileAgentList();
    openFile("existing.ts");
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
  });
});
