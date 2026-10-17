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

export function paneTabKeys(tabs: readonly WorkspaceTab[]): string[] {
  const keys = tabs.map(tabKey);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  // Shared target identities cannot distinguish repeated instances in one pane.
  return keys.map((key, index) => (counts.get(key)! > 1 ? `local:${tabs[index]!.tabId}` : key));
}

export function applyTabOrder(initial: WorkspaceLayout, order: readonly string[]): WorkspaceLayout {
  let layout = initial;
  for (const pane of collectAllPanes(initial.root)) {
    const tabs = collectAllTabs({ kind: "pane", pane });
    const keys = paneTabKeys(tabs);
    const reordered = applySharedOrder(keys, order);
    if (ordersEqual(keys, reordered)) continue;
    const byKey = new Map(keys.map((key, index) => [key, tabs[index]!.tabId]));
    layout = reorderPaneTabsInLayout({
      layout,
      paneId: pane.id,
      tabIds: reordered.map((key) => byKey.get(key)!),
    })!;
  }
  return layout;
}
