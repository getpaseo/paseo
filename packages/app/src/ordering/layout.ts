import { applySharedOrder, ordersEqual } from "@getpaseo/protocol/ordering";
import {
  collectAllTabs,
  collectAllPanes,
  reorderPaneTabsInLayout,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import type { WorkspaceTab } from "@/workspace-tabs/model";
export function tabKey(tab: WorkspaceTab): string {
  const target = tab.target;
  return target.kind === "new_tab" || target.kind === "draft" || target.kind === "commit_diff"
    ? `local:${tab.tabId}`
    : buildDeterministicWorkspaceTabId(target);
}

export function applyTabOrder(initial: WorkspaceLayout, order: readonly string[]): WorkspaceLayout {
  let layout = initial;
  for (const pane of collectAllPanes(initial.root)) {
    const tabs = collectAllTabs({ kind: "pane", pane });
    const keys = tabs.map(tabKey);
    const reordered = applySharedOrder(keys, order);
    if (ordersEqual(keys, reordered)) continue;
    const byKey = new Map<string, string[]>();
    for (const tab of tabs) {
      const key = tabKey(tab);
      const ids = byKey.get(key) ?? [];
      ids.push(tab.tabId);
      byKey.set(key, ids);
    }
    layout = reorderPaneTabsInLayout({
      layout,
      paneId: pane.id,
      tabIds: reordered.map((key) => byKey.get(key)!.shift()!),
    })!;
  }
  return layout;
}
