import { describe, expect, it, vi } from "vitest";
import {
  buildExplorerSidebarConfigurationEntries,
  EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER,
} from "@/screens/workspace/explorer-sidebar-tab-configuration";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import type { WorkspaceTabLaunchItem } from "@/workspace-tabs/launcher";

function createFilesTab(): WorkspaceTabDescriptor {
  return {
    key: "files",
    tabId: "files",
    kind: "files",
    target: { kind: "files" },
  };
}

function hasFilesTab(tabs: WorkspaceTabDescriptor[]): boolean {
  return tabs.some((tab) => tab.target.kind === "files");
}

function removeTab(tabs: WorkspaceTabDescriptor[], tabId: string): WorkspaceTabDescriptor[] {
  return tabs.filter((tab) => tab.tabId !== tabId);
}

function createFilesConfigurationHarness() {
  let tabs: WorkspaceTabDescriptor[] = [createFilesTab()];
  const launch = vi.fn((_destination: Parameters<WorkspaceTabLaunchItem["launch"]>[0]) => {
    if (!hasFilesTab(tabs)) {
      tabs = [...tabs, createFilesTab()];
    }
  });
  const onCloseTab = vi.fn((tabId: string) => {
    tabs = removeTab(tabs, tabId);
  });
  const filesItem: WorkspaceTabLaunchItem = {
    id: "files",
    label: "Files",
    disabled: false,
    panelKind: "files",
    launch,
  };

  return {
    launch,
    onCloseTab,
    get tabs() {
      return tabs;
    },
    buildEntries() {
      return buildExplorerSidebarConfigurationEntries({
        items: [filesItem],
        tabs,
        paneId: "explorer",
        onCloseTab,
      });
    },
  };
}

describe("Explorer sidebar tab configuration", () => {
  it("closes and restores the Files singleton without launching a duplicate", () => {
    const harness = createFilesConfigurationHarness();

    let entries = harness.buildEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ selected: true, disabled: false });
    entries[0]?.onSelect();

    expect(harness.onCloseTab).toHaveBeenCalledWith("files");
    expect(harness.tabs).toEqual([]);

    entries = harness.buildEntries();
    expect(entries[0]).toMatchObject({ selected: false, disabled: false });
    entries[0]?.onSelect();

    expect(harness.launch).toHaveBeenCalledWith({ kind: "open", paneId: "explorer" });
    expect(hasFilesTab(harness.tabs)).toBe(true);
    expect(harness.tabs).toHaveLength(1);

    entries = harness.buildEntries();
    expect(entries[0]).toMatchObject({ selected: true, disabled: false });
    entries[0]?.onSelect();

    expect(harness.launch).toHaveBeenCalledTimes(1);
  });

  it("describes a direct menu trigger that opts out of the draggable titlebar region", () => {
    expect(EXPLORER_SIDEBAR_CONFIGURATION_TRIGGER).toEqual({
      kind: "menu",
      labelKey: "workspace.git.actions.moreActions",
      testID: "explorer-sidebar-configuration-menu-trigger",
      titlebarStyle: {
        WebkitAppRegion: "no-drag",
      },
    });
  });
});
