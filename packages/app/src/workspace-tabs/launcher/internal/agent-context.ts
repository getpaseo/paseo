import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  getFocusedAgentId,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-store";
import { getWorkspaceTabAgentId, type WorkspaceTab } from "@/workspace-tabs/model";

export interface LauncherLaunchOrigin {
  /** Pane whose tabs-row menu launched the item. */
  paneId?: string | null;
  /** Tab being replaced — the persistent New tab. */
  tabId?: string | null;
}

/**
 * Agent candidates a launched tab could attach to, best first.
 *
 * The Command Center can ask for the focused tab and stop there, because the
 * user is looking at that tab when they open it. A launcher cannot: the pane it
 * launches from often holds the New tab itself, so the focused tab resolves to
 * nothing exactly when an answer is needed. Hence the chain — the launching
 * pane's own agent, the focused tab's agent, a visible agent in another pane,
 * then any open agent, newest first.
 *
 * Newest-first is a tiebreak, not a claim about recency of use. Tabs carry no
 * last-focused timestamp, so a workspace with several background agents gets
 * the most recently opened one.
 */
export function resolveLauncherAgentCandidates(
  layout: WorkspaceLayout | null,
  origin?: LauncherLaunchOrigin,
): string[] {
  if (!layout) return [];
  const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
  const panes = collectAllPanes(layout.root);
  const candidates: string[] = [];
  const add = (agentId: string | null | undefined) => {
    if (agentId && !candidates.includes(agentId)) candidates.push(agentId);
  };

  const originTabId = origin?.tabId ?? null;
  let originPane = null;
  if (origin?.paneId) {
    originPane = findPaneById(layout.root, origin.paneId);
  } else if (originTabId) {
    originPane = panes.find((pane) => pane.tabIds.includes(originTabId)) ?? null;
  }
  const originTab = originPane?.focusedTabId ? tabsById.get(originPane.focusedTabId) : undefined;
  if (originTab) add(getWorkspaceTabAgentId(originTab.target));

  add(getFocusedAgentId(layout));

  const visible = panes.flatMap((pane) => {
    const tab = pane.focusedTabId ? tabsById.get(pane.focusedTabId) : undefined;
    return tab ? [tab] : [];
  });
  for (const tab of newestFirstAgentTabs(visible)) add(getWorkspaceTabAgentId(tab.target));
  for (const tab of newestFirstAgentTabs([...tabsById.values()]))
    add(getWorkspaceTabAgentId(tab.target));
  return candidates;
}

/**
 * The agent a launched tab should attach to: the best candidate that passes
 * `isEligible`. Eligibility runs inside the resolution so a stale reference —
 * a leftover panel tab bound to a deleted or archived agent — falls through to
 * the next open agent instead of vetoing them all.
 */
export function resolveLauncherAgentId(
  layout: WorkspaceLayout | null,
  options?: { origin?: LauncherLaunchOrigin; isEligible?: (agentId: string) => boolean },
): string | null {
  for (const agentId of resolveLauncherAgentCandidates(layout, options?.origin)) {
    if (!options?.isEligible || options.isEligible(agentId)) return agentId;
  }
  return null;
}

function newestFirstAgentTabs(tabs: readonly WorkspaceTab[]): WorkspaceTab[] {
  return tabs
    .filter((tab) => getWorkspaceTabAgentId(tab.target) !== null)
    .sort((a, b) => b.createdAt - a.createdAt);
}
