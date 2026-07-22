import { buildDraftStoreKey } from "@/stores/draft-keys";
import {
  collectAllTabs,
  findPaneById,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";

export interface FocusedChatTarget {
  tabId: string;
  draftKey: string;
}

export function resolveFocusedChatTarget(input: {
  serverId: string;
  layout: WorkspaceLayout | undefined;
}): FocusedChatTarget | null {
  if (!input.layout) {
    return null;
  }
  const pane = findPaneById(input.layout.root, input.layout.focusedPaneId);
  const focusedTabId = pane?.focusedTabId;
  if (!focusedTabId) {
    return null;
  }
  const tab = collectAllTabs(input.layout.root).find(
    (candidate) => candidate.tabId === focusedTabId,
  );
  if (!tab) {
    return null;
  }
  if (tab.target.kind === "agent") {
    return {
      tabId: tab.tabId,
      draftKey: buildDraftStoreKey({ serverId: input.serverId, agentId: tab.target.agentId }),
    };
  }
  if (tab.target.kind === "draft") {
    return {
      tabId: tab.tabId,
      draftKey: buildDraftStoreKey({
        serverId: input.serverId,
        agentId: tab.tabId,
        draftId: tab.target.draftId,
      }),
    };
  }
  return null;
}
