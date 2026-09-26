import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { DEFAULT_APP_SETTINGS } from "@/hooks/use-settings";
import {
  DEFAULT_PANE_ID,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { openPreferredWorkspaceTarget } from "@/workspace-tabs/open-beside";

const WORKSPACE_KEY = "server-1:workspace-1";

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
});

function openAgentInSplit() {
  const store = useWorkspaceLayoutStore.getState();
  store.openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "left-agent" },
    intent: "reveal",
  });
  const rightTabId = store.openTab({
    workspaceKey: WORKSPACE_KEY,
    target: { kind: "agent", agentId: "right-agent" },
    intent: "reveal",
  });
  if (!rightTabId) throw new Error("right agent tab was not opened");
  const rightPaneId = store.splitPane(WORKSPACE_KEY, {
    tabId: rightTabId,
    targetPaneId: DEFAULT_PANE_ID,
    position: "right",
  });
  if (!rightPaneId) throw new Error("split was not created");
  // Clicking a button in a pane does not focus that pane, so the left pane stays focused.
  store.focusPane(WORKSPACE_KEY, DEFAULT_PANE_ID);
  return { rightTabId, rightPaneId };
}

function paneOf(tabId: string | null) {
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
  return layout && tabId ? findPaneContainingTab(layout.root, tabId)?.id : null;
}

describe("openPreferredWorkspaceTarget", () => {
  it("opens a subagent in the pane of the agent it was opened from", () => {
    const { rightTabId, rightPaneId } = openAgentInSplit();

    const subagentTabId = openPreferredWorkspaceTarget({
      isCompact: false,
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "subagent" },
      source: "subagents",
      preferences: { ...DEFAULT_APP_SETTINGS.openInSidePane, subagents: false },
      parentTabId: rightTabId,
    });

    expect(paneOf(subagentTabId)).toBe(rightPaneId);
  });
});
