import { buildDraftStoreKey } from "@/stores/draft-keys";
import {
  collectAllPanes,
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

/**
 * The chat a file should attach to. The focused pane answers first, then the tab it
 * came from — a file opened beside a chat belongs to that chat. Failing both, any
 * chat the user can see: standing in the Explorer sidebar looking at Changes, "add to
 * chat" plainly means the chat in the pane next to it.
 */
export function resolveFocusedChatTarget(input: {
  serverId: string;
  layout: WorkspaceLayout | undefined;
}): FocusedChatTarget | null {
  if (!input.layout) {
    return null;
  }
  const tabs = collectAllTabs(input.layout.root);
  const focusedTabId = findPaneById(input.layout.root, input.layout.focusedPaneId)?.focusedTabId;
  if (focusedTabId) {
    const focusedChat = resolveChatTab(
      input.serverId,
      tabs.find((candidate) => candidate.tabId === focusedTabId),
    );
    if (focusedChat) {
      return focusedChat;
    }
    const parentTabId = input.layout.parentTabIdByTabId?.[focusedTabId];
    const parentChat = resolveChatTab(
      input.serverId,
      tabs.find((candidate) => candidate.tabId === parentTabId),
    );
    if (parentChat) {
      return parentChat;
    }
  }

  for (const pane of collectAllPanes(input.layout.root)) {
    const paneChat = resolveChatTab(
      input.serverId,
      tabs.find((candidate) => candidate.tabId === pane.focusedTabId),
    );
    if (paneChat) {
      return paneChat;
    }
  }
  return null;
}
