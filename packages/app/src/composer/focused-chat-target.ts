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

function resolveChatTab(
  serverId: string,
  tab: ReturnType<typeof collectAllTabs>[number] | undefined,
): FocusedChatTarget | null {
  if (tab?.target.kind === "agent") {
    return {
      tabId: tab.tabId,
      draftKey: buildDraftStoreKey({ serverId, agentId: tab.target.agentId }),
    };
  }
  if (tab?.target.kind === "draft") {
    return {
      tabId: tab.tabId,
      draftKey: buildDraftStoreKey({
        serverId,
        agentId: tab.tabId,
        draftId: tab.target.draftId,
      }),
    };
  }
  return null;
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
  const tabs = collectAllTabs(input.layout.root);
  const tab = tabs.find((candidate) => candidate.tabId === focusedTabId);
  const focusedChat = resolveChatTab(input.serverId, tab);
  if (focusedChat) {
    return focusedChat;
  }
  const parentTabId = input.layout.parentTabIdByTabId?.[focusedTabId];
  return resolveChatTab(
    input.serverId,
    tabs.find((candidate) => candidate.tabId === parentTabId),
  );
}
