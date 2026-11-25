import type {
  WorkspaceSharedSplit,
  WorkspaceSharedTab,
  WorkspaceTabLayout,
  WorkspaceTabLayoutOperation,
} from "@getpaseo/protocol/workspace-tab-layout";
import { isValidWorkspaceSharedSplit } from "@getpaseo/protocol/workspace-tab-layout";
import {
  collectAllPanes,
  collectAllTabs,
  createWorkspaceLayoutWithExplorerSidebar,
  normalizeLayout,
  selectTabInPaneInLayout,
  type SplitNode,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import { createNewWorkspaceTab } from "@/workspace-tabs/new-tab";

interface TabLayoutProjection {
  layout: WorkspaceLayout;
  explorerId: string | null;
  sizes?: Record<string, number[]>;
}

function sharedTab(tab: WorkspaceTab, isExplorer: boolean): WorkspaceSharedTab | null {
  switch (tab.target.kind) {
    case "draft":
    case "new_tab":
    case "commit_diff":
    case "browser":
      return null;
    case "files":
    case "changes_tree":
      // The Explorer's default views are chrome. A standalone instance belongs to the tab list.
      if (isExplorer && tab.tabId === tab.target.kind) return null;
      break;
    case "file":
      return { tabId: tab.tabId, target: { kind: "file", path: tab.target.path } };
    case "working_diff":
      return { tabId: tab.tabId, target: { kind: "working_diff" } };
  }
  return { tabId: tab.tabId, target: tab.target };
}

function projectSplit(input: TabLayoutProjection): WorkspaceSharedSplit | undefined {
  const nodes: WorkspaceSharedSplit["nodes"] = [];
  function visit(node: SplitNode): string | null {
    if (node.kind === "pane") {
      const { id } = node.pane;
      if (id === input.explorerId) return null;
      const tabIds = collectAllTabs(node).flatMap((tab) => sharedTab(tab, false)?.tabId ?? []);
      nodes.push({ kind: "pane", id, tabIds });
      return id;
    }

    const { id, direction, children } = node.group;
    const sizes = input.sizes?.[id] ?? node.group.sizes;
    const surviving = children.flatMap((child, index) => {
      const childId = visit(child);
      return childId ? [{ childId, size: sizes[index] ?? 1 }] : [];
    });
    if (surviving.length <= 1) return surviving[0]?.childId ?? null;
    const total = surviving.reduce((sum, child) => sum + child.size, 0);
    nodes.push({
      kind: "group",
      id,
      direction,
      childIds: surviving.map((child) => child.childId),
      sizes: surviving.map((child) => child.size / total),
    });
    return id;
  }
  const rootId = visit(input.layout.root);
  return rootId ? { rootId, nodes } : undefined;
}

export function projectWorkspaceTabLayout(
  input: TabLayoutProjection & { hidden?: Set<string>; pinned?: Set<string>; syncSplits: boolean },
): WorkspaceTabLayout {
  return {
    tabs: collectAllPanes(input.layout.root, true).flatMap((pane) =>
      (pane.tabs ?? []).flatMap((tab) => sharedTab(tab, pane.id === input.explorerId) ?? []),
    ),
    hiddenAgentIds: [...(input.hidden ?? [])],
    pinnedAgentIds: [...(input.pinned ?? [])],
    split: input.syncSplits ? projectSplit(input) : undefined,
  };
}

/** Find the tabs whose relative order stayed the same so a drag moves only the affected IDs. */
function unchangedOrder(previous: string[], next: string[]): Set<string> {
  const rank = new Map(previous.map((id, index) => [id, index]));
  const tails: { id: string; rank: number; previous: number }[] = [];
  const paths: typeof tails = [];
  for (const id of next) {
    const index = rank.get(id);
    if (index === undefined) continue;
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (tails[middle].rank < index) low = middle + 1;
      else high = middle;
    }
    const item = { id, rank: index, previous: tails[low - 1]?.previous ?? -1 };
    paths.push(item);
    tails[low] = { ...item, previous: paths.length - 1 };
  }
  const unchanged = new Set<string>();
  let index = tails.at(-1)?.previous ?? -1;
  while (index >= 0) {
    const item = paths[index];
    unchanged.add(item.id);
    index = item.previous;
  }
  return unchanged;
}

export function diffWorkspaceTabLayout(
  before: WorkspaceTabLayout,
  after: WorkspaceTabLayout,
): WorkspaceTabLayoutOperation[] {
  const operations: WorkspaceTabLayoutOperation[] = [];
  const oldTabs = new Map(before.tabs.map((tab) => [tab.tabId, tab]));
  const newTabs = new Map(after.tabs.map((tab) => [tab.tabId, tab]));
  const stableTarget = (id: string) =>
    JSON.stringify(oldTabs.get(id)?.target) === JSON.stringify(newTabs.get(id)?.target);

  for (const { tabId } of before.tabs) {
    if (!newTabs.has(tabId) || !stableTarget(tabId)) operations.push({ kind: "close", tabId });
  }
  // Work backwards so the right anchor already has its final position in this batch.
  const orderedIds = after.tabs.map((tab) => tab.tabId);
  const unchanged = unchangedOrder(
    before.tabs.map((tab) => tab.tabId),
    orderedIds.filter(stableTarget),
  );
  for (let index = after.tabs.length - 1; index >= 0; index--) {
    const tab = after.tabs[index];
    const position =
      index === after.tabs.length - 1
        ? {}
        : { after: orderedIds[index - 1], before: orderedIds[index + 1] };
    if (!oldTabs.has(tab.tabId) || !stableTarget(tab.tabId)) {
      operations.push({ kind: "open", tab, ...position });
    } else if (!unchanged.has(tab.tabId)) {
      operations.push({ kind: "move", tabId: tab.tabId, ...position });
    }
  }
  for (const agentId of new Set([...before.hiddenAgentIds, ...after.hiddenAgentIds])) {
    const hidden = after.hiddenAgentIds.includes(agentId);
    if (hidden !== before.hiddenAgentIds.includes(agentId))
      operations.push({ kind: "hide", agentId, hidden });
  }
  for (const agentId of new Set([...before.pinnedAgentIds, ...after.pinnedAgentIds])) {
    const pinned = after.pinnedAgentIds.includes(agentId);
    if (pinned !== before.pinnedAgentIds.includes(agentId))
      operations.push({ kind: "pin", agentId, pinned });
  }
  if (after.split && JSON.stringify(before.split) !== JSON.stringify(after.split)) {
    operations.push({ kind: "split", split: after.split });
  }
  return operations;
}

function inflateSplit(split: WorkspaceSharedSplit): SplitNode | undefined {
  if (!isValidWorkspaceSharedSplit(split)) return undefined;
  const nodes = new Map(split.nodes.map((node) => [node.id, node]));
  function visit(id: string): SplitNode {
    const node = nodes.get(id)!;
    if (node.kind === "pane") {
      const pane = { id, tabIds: [], focusedTabId: null, tabs: [] };
      return { kind: "pane", pane };
    }
    return {
      kind: "group",
      group: {
        id,
        direction: node.direction,
        sizes: node.sizes,
        children: node.childIds.map(visit),
      },
    };
  }
  return visit(split.rootId);
}

function nearestAssignedPane(
  tabIds: readonly string[],
  index: number,
  assigned: Map<string, string>,
): string | undefined {
  for (let delta = 1; delta < tabIds.length; delta++) {
    const pane = assigned.get(tabIds[index - delta]) ?? assigned.get(tabIds[index + delta]);
    if (pane) return pane;
  }
  return undefined;
}

type Pane = ReturnType<typeof collectAllPanes>[number];

function attachExplorer(root: SplitNode, explorer: Pane | undefined): SplitNode {
  if (!explorer) return root;
  const shell = createWorkspaceLayoutWithExplorerSidebar().root;
  if (shell.kind !== "group") return root;
  // The dock is outside the user split tree. Keep its local visibility and contents.
  return {
    kind: "group",
    group: {
      ...shell.group,
      id: "workspace-tab-sync-explorer",
      children: [root, { kind: "pane", pane: explorer }],
    },
  };
}

function distributeSharedTabs(input: {
  previousPanes: Pane[];
  explorerId: string | null;
  tabsByPane: Map<string, WorkspaceTab[]>;
  focusedPaneId: string | null;
  shared: WorkspaceSharedTab[];
  split?: WorkspaceSharedSplit;
}) {
  const { previousPanes, explorerId, tabsByPane, focusedPaneId, shared, split } = input;
  const priorTabs = new Map<string, WorkspaceTab>();
  const assigned = new Map<string, string>();
  const orderedIds = shared.map((tab) => tab.tabId);
  if (split) {
    for (const node of split.nodes) {
      if (node.kind === "pane") {
        for (const tabId of node.tabIds) assigned.set(tabId, node.id);
      }
    }
  }
  for (const pane of previousPanes) {
    for (const tab of pane.tabs) {
      if (!sharedTab(tab, pane.id === explorerId)) continue;
      priorTabs.set(tab.tabId, tab);
      if (
        (!split || pane.id === explorerId) &&
        tabsByPane.has(pane.id) &&
        !assigned.has(tab.tabId)
      ) {
        assigned.set(tab.tabId, pane.id);
      }
    }
  }
  const now = Date.now();
  shared.forEach((entry, index) => {
    const paneId =
      assigned.get(entry.tabId) ??
      nearestAssignedPane(orderedIds, index, assigned) ??
      focusedPaneId;
    if (!paneId) return;
    const previous = priorTabs.get(entry.tabId);
    const target = previous ? sharedTab(previous, false)?.target : undefined;
    tabsByPane
      .get(paneId)
      ?.push(
        previous && JSON.stringify(target) === JSON.stringify(entry.target)
          ? previous
          : { ...entry, createdAt: now },
      );
  });
}

function attachLocalTabs(input: {
  previousPanes: Pane[];
  explorerId: string | null;
  focusedPaneId: string | null;
  tabsByPane: Map<string, WorkspaceTab[]>;
  sharedIds: Set<string>;
}) {
  const { previousPanes, explorerId, focusedPaneId, tabsByPane, sharedIds } = input;
  const before = new Map<string, WorkspaceTab[]>();
  const after = new Map<string, WorkspaceTab[]>();
  for (const pane of previousPanes) {
    const isExplorer = pane.id === explorerId;
    const surviving = (candidate: WorkspaceTab) =>
      sharedIds.has(candidate.tabId) && sharedTab(candidate, isExplorer);
    const destination = tabsByPane.has(pane.id) ? pane.id : focusedPaneId;
    let left: WorkspaceTab | undefined;
    const first = pane.tabs.find(surviving);
    for (const tab of pane.tabs) {
      if (sharedTab(tab, isExplorer)) {
        if (surviving(tab)) left = tab;
        continue;
      }
      const anchor = left ?? first;
      if (anchor && !isExplorer) {
        const attachments = left ? after : before;
        const attached = attachments.get(anchor.tabId) ?? [];
        attached.push(tab);
        attachments.set(anchor.tabId, attached);
      } else if (destination) {
        tabsByPane.get(destination)?.push(tab);
      }
    }
  }
  for (const [paneId, entries] of tabsByPane) {
    const tabs: WorkspaceTab[] = [];
    for (const tab of entries) {
      tabs.push(...(before.get(tab.tabId) ?? []), tab, ...(after.get(tab.tabId) ?? []));
    }
    tabsByPane.set(paneId, tabs);
  }
}

function populatePanes(
  node: SplitNode,
  previousById: Map<string, Pane>,
  tabsByPane: Map<string, WorkspaceTab[]>,
  explorerId: string | null,
): SplitNode {
  if (node.kind === "group") {
    const children = node.group.children.map((child) =>
      populatePanes(child, previousById, tabsByPane, explorerId),
    );
    return { ...node, group: { ...node.group, children } };
  }
  const previous = previousById.get(node.pane.id);
  const tabs = tabsByPane.get(node.pane.id) ?? [];
  if (tabs.length === 0 && node.pane.id !== explorerId) tabs.push(createNewWorkspaceTab());
  const tabIds = tabs.map((tab) => tab.tabId);
  const focusedTabId = previous?.focusedTabId;
  const pane = {
    ...node.pane,
    tabs,
    tabIds,
    focusedTabId:
      focusedTabId && tabIds.includes(focusedTabId) ? focusedTabId : (tabIds[0] ?? null),
  };
  return { kind: "pane", pane };
}

export function mergeWorkspaceTabLayout(
  input: TabLayoutProjection & {
    remote: WorkspaceTabLayout;
    syncSplits: boolean;
  },
): { layout: WorkspaceLayout; sizes: Record<string, number[]> | undefined } {
  const { layout: current, explorerId, remote } = input;
  const previousPanes = collectAllPanes(current.root, true);
  const previousById = new Map(previousPanes.map((pane) => [pane.id, pane]));
  const split = input.syncSplits ? remote.split : undefined;
  const syncedRoot = split ? inflateSplit(split) : undefined;
  const explorer = explorerId ? previousById.get(explorerId) : undefined;
  const root = syncedRoot ? attachExplorer(syncedRoot, explorer) : current.root;
  const panes = collectAllPanes(root, true);
  const previousFocus = previousById.get(current.focusedPaneId ?? "");
  const firstOrdinaryPaneId =
    panes.find((pane) => pane.id !== explorerId && !pane.hidden)?.id ?? null;
  const focusedPaneId =
    panes.find((pane) => pane.id === previousFocus?.id && pane.id !== explorerId)?.id ??
    firstOrdinaryPaneId;
  const tabsByPane = new Map<string, WorkspaceTab[]>(panes.map((pane) => [pane.id, []]));
  distributeSharedTabs({
    previousPanes,
    explorerId,
    tabsByPane,
    // A client outside the split policy can open a tab without a pane assignment.
    // Use a deterministic fallback so all clients sharing the tree agree on its pane.
    focusedPaneId: syncedRoot ? firstOrdinaryPaneId : focusedPaneId,
    shared: remote.tabs,
    split: syncedRoot ? split : undefined,
  });
  attachLocalTabs({
    previousPanes,
    explorerId,
    focusedPaneId,
    tabsByPane,
    sharedIds: new Set(remote.tabs.map((tab) => tab.tabId)),
  });
  const focusedTabId = previousFocus?.focusedTabId;
  const focusedTabPaneId = [...tabsByPane].find(
    ([paneId, tabs]) => paneId !== explorerId && tabs.some((tab) => tab.tabId === focusedTabId),
  )?.[0];
  const layout = normalizeLayout({
    ...current,
    root: populatePanes(root, previousById, tabsByPane, explorerId),
    focusedPaneId: focusedTabPaneId ?? focusedPaneId,
  });
  const pane = collectAllPanes(layout.root).find((entry) => entry.id === focusedTabPaneId);
  const preserved =
    pane && focusedTabId
      ? selectTabInPaneInLayout({ layout, paneId: pane.id, tabId: focusedTabId })
      : null;
  return {
    layout: preserved ?? layout,
    sizes:
      split && syncedRoot
        ? Object.fromEntries(
            split.nodes.flatMap((node) => (node.kind === "group" ? [[node.id, node.sizes]] : [])),
          )
        : input.sizes,
  };
}
