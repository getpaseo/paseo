import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import { usePanelStore } from "@/stores/panel-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { openWorkspaceSupportingView } from "@/workspace-tabs/open-supporting-view";

const WORKSPACE_KEY = "server-1:workspace-1";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };

beforeEach(() => {
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTab: "files",
    explorerTabByCheckout: {},
  });
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

describe("openWorkspaceSupportingView", () => {
  it.each([
    ["changes", "changes"],
    ["pull-request", "pr"],
  ] as const)("opens %s in the compact Explorer", (view, explorerTab) => {
    openWorkspaceSupportingView({
      view,
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe(explorerTab);
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });

  it("uses the combined Explorer dock on native layouts without pane splits", () => {
    openWorkspaceSupportingView({
      view: "pull-request",
      isCompact: false,
      supportsPaneSplits: false,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      preferences: DEFAULT_APP_SETTINGS.openInSidePane,
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("pr");
  });
});
