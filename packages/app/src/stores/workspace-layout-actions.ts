import invariant from "tiny-invariant";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/utils/workspace-tab-identity";

export interface SplitPane {
  id: string;
  tabIds: string[];
  focusedTabId: string | null;
}

export interface SplitGroup {
  id: string;
  direction: "horizontal" | "vertical";
  children: SplitNode[];
  sizes: number[];
}

export type SplitNode = { kind: "pane"; pane: SplitPane } | { kind: "group"; group: SplitGroup };

export interface WorkspaceLayout {
  root: SplitNode;
  focusedPaneId: string;
}

interface SplitPaneInternal extends SplitPane {
  tabs: WorkspaceTab[];
}

interface SplitGroupInternal extends Omit<SplitGroup, "children"> {
  children: SplitNodeInternal[];
}

type SplitNodeInternal =
  | { kind: "pane"; pane: SplitPaneInternal }
  | { kind: "group"; group: SplitGroupInternal };

interface NormalizeSizesInput {
  sizes: number[];
  count: number;
}

interface ReorderTabsForPaneInput {
  pane: SplitPaneInternal;
  tabIds: string[];
}

interface UpdateTabInTreeInput {
  tabId: string;
  target: WorkspaceTabTarget;
}

interface UpdateGroupSizesInTreeInput {
  groupId: string;
  sizes: number[];
}

interface UpdatePaneInTreeInput {
  paneId: string;
  updater: (pane: SplitPaneInternal) => SplitPaneInternal;
}

interface InsertChildIntoGroupInput {
  index: number;
  node: SplitNodeInternal;
  sizes: number[];
}

interface DetachTabFromTreeInput {
  tabId: string;
  preserveEmptyPaneId?: string | null;
}

interface DetachTabFromTreeResult {
  root: SplitNodeInternal;
  tab: WorkspaceTab | null;
  sourcePaneId: string | null;
}

interface InsertTabIntoPaneInput {
  paneId: string;
  tab: WorkspaceTab;
  focusTabId?: string | null;
}

interface InsertSplitInternalInput {
  root: SplitNodeInternal;
  targetPaneId: string;
  tabId: string;
  position: "left" | "right" | "top" | "bottom";
  createNodeId: (prefix: "pane" | "group") => string;
}

interface InsertSplitInternalResult {
  root: SplitNodeInternal;
  newPaneId: string;
}

interface OpenTabInLayoutInput {
  layout: WorkspaceLayout;
  target: WorkspaceTabTarget;
  now: number;
}

interface OpenTabInLayoutResult {
  layout: WorkspaceLayout;
  tabId: string;
}

interface RetargetTabInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  target: WorkspaceTabTarget;
}

interface RetargetTabInLayoutResult {
  layout: WorkspaceLayout;
  tabId: string;
}

interface ConvertDraftToAgentInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  agentId: string;
}

interface ConvertDraftToAgentInLayoutResult {
  layout: WorkspaceLayout;
  tabId: string;
}

interface ReorderFocusedPaneTabsInLayoutInput {
  layout: WorkspaceLayout;
  tabIds: string[];
}

interface CloseTabInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
}

interface SplitPaneInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  targetPaneId: string;
  position: "left" | "right" | "top" | "bottom";
  createNodeId: (prefix: "pane" | "group") => string;
  maxTreeDepth: number;
}

interface SplitPaneInLayoutResult {
  layout: WorkspaceLayout;
  paneId: string;
}

interface SplitPaneEmptyInLayoutInput {
  layout: WorkspaceLayout;
  targetPaneId: string;
  position: "left" | "right" | "top" | "bottom";
  createNodeId: (prefix: "pane" | "group") => string;
  maxTreeDepth: number;
}

interface MoveTabToPaneInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
  toPaneId: string;
}

interface FocusTabInLayoutInput {
  layout: WorkspaceLayout;
  tabId: string;
}

interface FocusPaneInLayoutInput {
  layout: WorkspaceLayout;
  paneId: string;
}

interface ResizeSplitInLayoutInput {
  layout: WorkspaceLayout;
  groupId: string;
  sizes: number[];
}

interface ReorderPaneTabsInLayoutInput {
  layout: WorkspaceLayout;
  paneId: string;
  tabIds: string[];
}

export interface WorkspaceTabReconcileState {
  layout: WorkspaceLayout;
  pinnedAgentIds?: ReadonlySet<string> | null;
  hiddenAgentIds?: ReadonlySet<string> | null;
}

export interface WorkspaceTabSnapshot {
  agentsHydrated: boolean;
  terminalsHydrated: boolean;
  activeAgentIds: Iterable<string>;
  knownAgentIds: Iterable<string>;
  knownTerminalIds?: Iterable<string>;
  standaloneTerminalIds: Iterable<string>;
  hasActivePendingDraftCreate?: boolean;
}

const DEFAULT_PANE_ID = "main";
const MIN_SPLIT_SIZE = 0.1;

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTabIds(list: unknown): string[] {
  if (!Array.isArray(list)) {
    return [];
  }
  const next: string[] = [];
  const seen = new Set<string>();
  for (const value of list) {
    const tabId = trimNonEmpty(typeof value === "string" ? value : null);
    if (!tabId || seen.has(tabId)) {
      continue;
    }
    seen.add(tabId);
    next.push(tabId);
  }
  return next;
}

function generateNodeId(prefix: "pane" | "group"): string {
  const randomValue =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomValue}`;
}

function createPaneNode(input: {
  id: string;
  tabs?: WorkspaceTab[];
  focusedTabId?: string | null;
}): SplitNodeInternal {
  const normalizedTabs = normalizeWorkspaceTabs(input.tabs ?? []);
  const tabIds = normalizedTabs.map((tab) => tab.tabId);
  const focusedTabId = tabIds.includes(input.focusedTabId ?? "")
    ? (input.focusedTabId ?? null)
    : (tabIds[tabIds.length - 1] ?? null);

  return {
    kind: "pane",
    pane: {
      id: input.id,
      tabs: normalizedTabs,
      tabIds,
      focusedTabId,
    },
  };
}

function createGroupNode(input: {
  id: string;
  direction: "horizontal" | "vertical";
  children: SplitNodeInternal[];
  sizes?: number[];
}): SplitNodeInternal {
  return {
    kind: "group",
    group: {
      id: input.id,
      direction: input.direction,
      children: input.children,
      sizes: normalizeSizes({
        sizes: input.sizes ?? input.children.map(() => 1 / Math.max(input.children.length, 1)),
        count: input.children.length,
      }),
    },
  };
}

function normalizeWorkspaceTab(value: unknown): WorkspaceTab | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const tab = value as WorkspaceTab;
  const target = normalizeWorkspaceTabTarget(tab.target);
  const tabId =
    trimNonEmpty(tab.tabId) ?? (target ? buildDeterministicWorkspaceTabId(target) : null);
  if (!target || !tabId) {
    return null;
  }

  return {
    tabId,
    target,
    createdAt: typeof tab.createdAt === "number" ? tab.createdAt : Date.now(),
  };
}

function normalizeWorkspaceTabs(input: unknown): WorkspaceTab[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const next: WorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const value of input) {
    const tab = normalizeWorkspaceTab(value);
    if (!tab || seen.has(tab.tabId)) {
      continue;
    }
    seen.add(tab.tabId);
    next.push(tab);
  }
  return next;
}

function normalizeSizes(input: NormalizeSizesInput): number[] {
  if (input.count <= 0) {
    return [];
  }

  const raw = input.sizes.slice(0, input.count);
  while (raw.length < input.count) {
    raw.push(1);
  }

  const sanitized = raw.map((value) => (Number.isFinite(value) && value > 0 ? value : 1));
  const total = sanitized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) {
    return Array.from({ length: input.count }, () => 1 / input.count);
  }
  return sanitized.map((value) => value / total);
}

export function clampNormalizedSizes(sizes: number[]): number[] {
  if (sizes.length === 0) {
    return [];
  }

  const normalized = normalizeSizes({ sizes, count: sizes.length });
  if (sizes.length === 1) {
    return [1];
  }
  if (sizes.length * MIN_SPLIT_SIZE > 1) {
    return Array.from({ length: sizes.length }, () => 1 / sizes.length);
  }

  const nextSizes = Array.from({ length: sizes.length }, () => 0);
  const unlocked = new Set(normalized.map((_, index) => index));
  let remainingTotal = 1;

  while (unlocked.size > 0) {
    let unlockedWeight = 0;
    for (const index of unlocked) {
      unlockedWeight += normalized[index] ?? 0;
    }

    if (unlockedWeight <= 0) {
      const evenShare = remainingTotal / unlocked.size;
      for (const index of unlocked) {
        nextSizes[index] = evenShare;
      }
      break;
    }

    const nextLocked: number[] = [];
    for (const index of unlocked) {
      const proposedSize = ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal;
      if (proposedSize < MIN_SPLIT_SIZE) {
        nextLocked.push(index);
      }
    }

    if (nextLocked.length === 0) {
      for (const index of unlocked) {
        nextSizes[index] = ((normalized[index] ?? 0) / unlockedWeight) * remainingTotal;
      }
      break;
    }

    for (const index of nextLocked) {
      nextSizes[index] = MIN_SPLIT_SIZE;
      unlocked.delete(index);
      remainingTotal -= MIN_SPLIT_SIZE;
    }
  }

  return normalizeSizes({ sizes: nextSizes, count: nextSizes.length });
}

function asInternalNode(node: SplitNode): SplitNodeInternal {
  return node as SplitNodeInternal;
}

function asInternalLayout(layout: WorkspaceLayout): {
  root: SplitNodeInternal;
  focusedPaneId: string;
} {
  return layout as { root: SplitNodeInternal; focusedPaneId: string };
}

function findPanePathById(
  node: SplitNodeInternal,
  paneId: string,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return node.pane.id === paneId ? path : null;
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const childPath = findPanePathById(node.group.children[index], paneId, [...path, index]);
    if (childPath) {
      return childPath;
    }
  }
  return null;
}

function findPanePathContainingTab(
  node: SplitNodeInternal,
  tabId: string,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return node.pane.tabs.some((tab) => tab.tabId === tabId) ? path : null;
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const childPath = findPanePathContainingTab(node.group.children[index], tabId, [
      ...path,
      index,
    ]);
    if (childPath) {
      return childPath;
    }
  }
  return null;
}

function findGroupPathById(
  node: SplitNodeInternal,
  groupId: string,
  path: number[] = [],
): number[] | null {
  if (node.kind === "pane") {
    return null;
  }
  if (node.group.id === groupId) {
    return path;
  }
  for (let index = 0; index < node.group.children.length; index += 1) {
    const childPath = findGroupPathById(node.group.children[index], groupId, [...path, index]);
    if (childPath) {
      return childPath;
    }
  }
  return null;
}

function getNodeAtPath(node: SplitNodeInternal, path: number[]): SplitNodeInternal {
  let current = node;
  for (const index of path) {
    invariant(current.kind === "group", "Expected group while traversing split tree");
    current = current.group.children[index];
  }
  return current;
}

function replaceNodeAtPath(
  node: SplitNodeInternal,
  path: number[],
  updater: (node: SplitNodeInternal) => SplitNodeInternal,
): SplitNodeInternal {
  if (path.length === 0) {
    return updater(node);
  }

  invariant(node.kind === "group", "Expected group while replacing split tree node");
  const [index, ...rest] = path;
  const nextChildren = node.group.children.map((child, childIndex) =>
    childIndex === index ? replaceNodeAtPath(child, rest, updater) : child,
  );

  return createGroupNode({
    id: node.group.id,
    direction: node.group.direction,
    children: nextChildren,
    sizes: node.group.sizes,
  });
}

function insertChildIntoGroup(
  groupNode: SplitNodeInternal,
  input: InsertChildIntoGroupInput,
): SplitNodeInternal {
  invariant(groupNode.kind === "group", "Expected group for split insertion");
  const nextChildren = groupNode.group.children.slice();
  nextChildren.splice(input.index, 0, input.node);
  return createGroupNode({
    id: groupNode.group.id,
    direction: groupNode.group.direction,
    children: nextChildren,
    sizes: input.sizes,
  });
}

function listPaneIds(node: SplitNodeInternal): string[] {
  if (node.kind === "pane") {
    return [node.pane.id];
  }
  const next: string[] = [];
  for (const child of node.group.children) {
    next.push(...listPaneIds(child));
  }
  return next;
}

function findNearestSiblingPaneId(root: SplitNodeInternal, paneId: string): string | null {
  const path = findPanePathById(root, paneId);
  if (!path || path.length === 0) {
    return null;
  }

  for (let depth = path.length - 1; depth >= 0; depth -= 1) {
    const parentPath = path.slice(0, depth);
    const childIndex = path[depth]!;
    const parentNode = getNodeAtPath(root, parentPath);
    invariant(parentNode.kind === "group", "Expected parent group for pane lookup");

    for (let index = childIndex - 1; index >= 0; index -= 1) {
      const paneIds = listPaneIds(parentNode.group.children[index]);
      if (paneIds.length > 0) {
        return paneIds[paneIds.length - 1] ?? null;
      }
    }

    for (let index = childIndex + 1; index < parentNode.group.children.length; index += 1) {
      const paneIds = listPaneIds(parentNode.group.children[index]);
      if (paneIds.length > 0) {
        return paneIds[0] ?? null;
      }
    }
  }

  return null;
}

function normalizePaneAfterTabChange(pane: SplitPaneInternal): SplitPaneInternal {
  const tabs = normalizeWorkspaceTabs(pane.tabs);
  const tabIds = tabs.map((tab) => tab.tabId);
  const focusedTabId = tabIds.includes(pane.focusedTabId ?? "")
    ? pane.focusedTabId
    : (tabIds[tabIds.length - 1] ?? null);

  return {
    id: pane.id,
    tabs,
    tabIds,
    focusedTabId,
  };
}

function normalizeNode(node: unknown): SplitNodeInternal | null {
  if (!node || typeof node !== "object") {
    return null;
  }

  if ((node as SplitNode).kind === "pane") {
    const rawPane = (node as { pane?: SplitPaneInternal }).pane;
    const paneId = trimNonEmpty(rawPane?.id);
    if (!paneId) {
      return null;
    }
    const tabs = normalizeWorkspaceTabs(rawPane?.tabs);
    const tabIds = normalizeTabIds(rawPane?.tabIds);
    const mergedTabs = (() => {
      if (tabs.length > 0) {
        return tabs;
      }
      return tabIds.map((tabId) => ({
        tabId,
        target: { kind: "draft", draftId: tabId } as WorkspaceTabTarget,
        createdAt: Date.now(),
      }));
    })();
    return createPaneNode({
      id: paneId,
      tabs: mergedTabs,
      focusedTabId: trimNonEmpty(rawPane?.focusedTabId) ?? null,
    });
  }

  if ((node as SplitNode).kind === "group") {
    const rawGroup = (node as { group?: SplitGroupInternal }).group;
    if (!rawGroup) {
      return null;
    }
    const groupId = trimNonEmpty(rawGroup?.id);
    const direction = rawGroup?.direction;
    if (!groupId || (direction !== "horizontal" && direction !== "vertical")) {
      return null;
    }

    const children = Array.isArray(rawGroup.children)
      ? rawGroup.children
          .map((child) => normalizeNode(child))
          .filter((child): child is SplitNodeInternal => child !== null)
      : [];
    if (children.length === 0) {
      return null;
    }
    if (children.length === 1) {
      return children[0] ?? null;
    }

    return createGroupNode({
      id: groupId,
      direction,
      children,
      sizes: Array.isArray(rawGroup.sizes) ? rawGroup.sizes : [],
    });
  }

  return null;
}

function reorderTabsForPane(input: ReorderTabsForPaneInput): SplitPaneInternal {
  const nextIds = normalizeTabIds(input.tabIds);
  const byId = new Map(input.pane.tabs.map((tab) => [tab.tabId, tab]));
  const reordered: WorkspaceTab[] = [];
  const seen = new Set<string>();

  for (const tabId of nextIds) {
    const tab = byId.get(tabId);
    if (!tab || seen.has(tabId)) {
      continue;
    }
    seen.add(tabId);
    reordered.push(tab);
  }

  for (const tab of input.pane.tabs) {
    if (seen.has(tab.tabId)) {
      continue;
    }
    seen.add(tab.tabId);
    reordered.push(tab);
  }

  return normalizePaneAfterTabChange({
    ...input.pane,
    tabs: reordered,
  });
}

function removePaneByPath(root: SplitNodeInternal, path: number[]): SplitNodeInternal {
  if (path.length === 0) {
    invariant(root.kind === "pane", "Expected pane at root while removing pane");
    return createPaneNode({ id: root.pane.id });
  }

  const parentPath = path.slice(0, -1);
  const removeIndex = path[path.length - 1]!;
  const parentNode = getNodeAtPath(root, parentPath);
  invariant(parentNode.kind === "group", "Expected parent group while removing pane");

  const nextParentChildren = parentNode.group.children.filter((_, index) => index !== removeIndex);
  invariant(nextParentChildren.length > 0, "Split tree cannot remove the final pane");

  const nextParentNode =
    nextParentChildren.length === 1
      ? nextParentChildren[0]!
      : createGroupNode({
          id: parentNode.group.id,
          direction: parentNode.group.direction,
          children: nextParentChildren,
          sizes: parentNode.group.sizes.filter((_, index) => index !== removeIndex),
        });

  return replaceNodeAtPath(root, parentPath, () => nextParentNode);
}

function detachTabFromTree(
  root: SplitNodeInternal,
  input: DetachTabFromTreeInput,
): DetachTabFromTreeResult {
  const panePath = findPanePathContainingTab(root, input.tabId);
  if (!panePath) {
    return { root, tab: null, sourcePaneId: null };
  }

  const paneNode = getNodeAtPath(root, panePath);
  invariant(paneNode.kind === "pane", "Expected pane while detaching tab");
  const tab = paneNode.pane.tabs.find((entry) => entry.tabId === input.tabId) ?? null;
  if (!tab) {
    return { root, tab: null, sourcePaneId: paneNode.pane.id };
  }

  const nextPane = normalizePaneAfterTabChange({
    ...paneNode.pane,
    tabs: paneNode.pane.tabs.filter((entry) => entry.tabId !== input.tabId),
  });

  const nextRoot = replaceNodeAtPath(root, panePath, () => ({ kind: "pane", pane: nextPane }));
  if (nextPane.tabs.length > 0 || nextPane.id === input.preserveEmptyPaneId) {
    return { root: nextRoot, tab, sourcePaneId: paneNode.pane.id };
  }

  return {
    root: removePaneByPath(nextRoot, panePath),
    tab,
    sourcePaneId: paneNode.pane.id,
  };
}

function insertTabIntoPane(
  root: SplitNodeInternal,
  input: InsertTabIntoPaneInput,
): SplitNodeInternal {
  const panePath = findPanePathById(root, input.paneId);
  invariant(panePath, `Pane not found: ${input.paneId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while inserting tab");
    const existingIndex = node.pane.tabs.findIndex((tab) => tab.tabId === input.tab.tabId);
    const nextTabs =
      existingIndex >= 0
        ? node.pane.tabs.map((tab, index) => (index === existingIndex ? input.tab : tab))
        : [...node.pane.tabs, input.tab];
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        tabs: nextTabs,
        focusedTabId: input.focusTabId ?? input.tab.tabId,
      }),
    };
  });
}

function focusTabInPane(root: SplitNodeInternal, paneId: string, tabId: string): SplitNodeInternal {
  const panePath = findPanePathById(root, paneId);
  invariant(panePath, `Pane not found: ${paneId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while focusing tab");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        focusedTabId: tabId,
      }),
    };
  });
}

function updateTabInTree(root: SplitNodeInternal, input: UpdateTabInTreeInput): SplitNodeInternal {
  const panePath = findPanePathContainingTab(root, input.tabId);
  invariant(panePath, `Tab not found: ${input.tabId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while retargeting tab");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        tabs: node.pane.tabs.map((tab) =>
          tab.tabId === input.tabId ? { ...tab, target: input.target } : tab,
        ),
      }),
    };
  });
}

function replaceTabInTree(
  root: SplitNodeInternal,
  input: {
    tabId: string;
    nextTabId: string;
    target: WorkspaceTabTarget;
  },
): SplitNodeInternal {
  const panePath = findPanePathContainingTab(root, input.tabId);
  invariant(panePath, `Tab not found: ${input.tabId}`);
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while replacing tab");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange({
        ...node.pane,
        tabs: node.pane.tabs.map((tab) =>
          tab.tabId === input.tabId
            ? {
                ...tab,
                tabId: input.nextTabId,
                target: input.target,
              }
            : tab,
        ),
        focusedTabId:
          node.pane.focusedTabId === input.tabId ? input.nextTabId : node.pane.focusedTabId,
      }),
    };
  });
}

function updateGroupSizesInTree(
  root: SplitNodeInternal,
  input: UpdateGroupSizesInTreeInput,
): SplitNodeInternal {
  const groupPath = findGroupPathById(root, input.groupId);
  if (!groupPath) {
    return root;
  }
  return replaceNodeAtPath(root, groupPath, (node) => {
    invariant(node.kind === "group", "Expected group while resizing split");
    if (input.sizes.length !== node.group.children.length) {
      return node;
    }
    return createGroupNode({
      id: node.group.id,
      direction: node.group.direction,
      children: node.group.children,
      sizes: clampNormalizedSizes(input.sizes),
    });
  });
}

function updatePaneInTree(
  root: SplitNodeInternal,
  input: UpdatePaneInTreeInput,
): SplitNodeInternal {
  const panePath = findPanePathById(root, input.paneId);
  if (!panePath) {
    return root;
  }
  return replaceNodeAtPath(root, panePath, (node) => {
    invariant(node.kind === "pane", "Expected pane while updating pane");
    return {
      kind: "pane",
      pane: normalizePaneAfterTabChange(input.updater(node.pane)),
    };
  });
}

function insertSplitInternal(input: InsertSplitInternalInput): InsertSplitInternalResult {
  const direction =
    input.position === "left" || input.position === "right" ? "horizontal" : "vertical";
  const insertAfter = input.position === "right" || input.position === "bottom";

  const targetPathBeforeDetach = findPanePathById(input.root, input.targetPaneId);
  invariant(targetPathBeforeDetach, `Target pane not found: ${input.targetPaneId}`);

  const detached = detachTabFromTree(input.root, {
    tabId: input.tabId,
    preserveEmptyPaneId: input.targetPaneId,
  });
  invariant(detached.tab, `Tab not found: ${input.tabId}`);

  const targetPath = findPanePathById(detached.root, input.targetPaneId);
  invariant(targetPath, `Target pane not found after detach: ${input.targetPaneId}`);
  const targetNode = getNodeAtPath(detached.root, targetPath);
  invariant(targetNode.kind === "pane", "Expected target pane after detach");

  const newPaneId = input.createNodeId("pane");
  const newPaneNode = createPaneNode({
    id: newPaneId,
    tabs: [detached.tab],
    focusedTabId: detached.tab.tabId,
  });

  const parentPath = targetPath.slice(0, -1);
  const targetIndex = targetPath[targetPath.length - 1] ?? 0;
  const parentNode = parentPath.length > 0 ? getNodeAtPath(detached.root, parentPath) : null;

  if (parentNode?.kind === "group" && parentNode.group.direction === direction) {
    const targetSize = parentNode.group.sizes[targetIndex] ?? 0;
    const nextSizes = parentNode.group.sizes.slice();
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
    nextSizes.splice(insertIndex, 0, targetSize / 2);
    nextSizes[targetIndex + (insertAfter ? 0 : 1)] = targetSize / 2;

    return {
      root: replaceNodeAtPath(detached.root, parentPath, () =>
        insertChildIntoGroup(parentNode, {
          index: insertIndex,
          node: newPaneNode,
          sizes: nextSizes,
        }),
      ),
      newPaneId,
    };
  }

  const newGroup = createGroupNode({
    id: input.createNodeId("group"),
    direction,
    children: insertAfter ? [targetNode, newPaneNode] : [newPaneNode, targetNode],
    sizes: [0.5, 0.5],
  });

  return {
    root: replaceNodeAtPath(detached.root, targetPath, () => newGroup),
    newPaneId,
  };
}

export function normalizeLayout(layout: unknown): WorkspaceLayout {
  if (!layout || typeof layout !== "object") {
    return createDefaultLayout();
  }

  const rawLayout = layout as WorkspaceLayout;
  const root = normalizeNode(rawLayout.root) ?? asInternalNode(createDefaultLayout().root);
  const focusedPaneId = trimNonEmpty(rawLayout.focusedPaneId);
  const resolvedFocusedPaneId =
    (focusedPaneId && findPaneById(root, focusedPaneId)?.id) ??
    collectAllPanes(root)[0]?.id ??
    DEFAULT_PANE_ID;

  return {
    root,
    focusedPaneId: resolvedFocusedPaneId,
  };
}

export function findPaneById(root: SplitNode, paneId: string): SplitPane | null {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return internalRoot.pane.id === paneId ? internalRoot.pane : null;
  }
  for (const child of internalRoot.group.children) {
    const pane = findPaneById(child, paneId);
    if (pane) {
      return pane;
    }
  }
  return null;
}

export function findPaneContainingTab(root: SplitNode, tabId: string): SplitPane | null {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return internalRoot.pane.tabs.some((tab) => tab.tabId === tabId) ? internalRoot.pane : null;
  }
  for (const child of internalRoot.group.children) {
    const pane = findPaneContainingTab(child, tabId);
    if (pane) {
      return pane;
    }
  }
  return null;
}

export function getTreeDepth(node: SplitNode): number {
  const internalNode = asInternalNode(node);
  if (internalNode.kind === "pane") {
    return 1;
  }
  return 1 + Math.max(...internalNode.group.children.map((child) => getTreeDepth(child)));
}

export function collectAllTabs(root: SplitNode): WorkspaceTab[] {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return internalRoot.pane.tabs.slice();
  }
  return internalRoot.group.children.flatMap((child) => collectAllTabs(child));
}

export function collectAllPanes(root: SplitNode): SplitPane[] {
  const internalRoot = asInternalNode(root);
  if (internalRoot.kind === "pane") {
    return [internalRoot.pane];
  }
  return internalRoot.group.children.flatMap((child) => collectAllPanes(child));
}

export function createDefaultLayout(): WorkspaceLayout {
  return {
    root: createPaneNode({ id: DEFAULT_PANE_ID }),
    focusedPaneId: DEFAULT_PANE_ID,
  };
}

export function insertSplit(
  root: SplitNode,
  targetPaneId: string,
  tabId: string,
  position: "left" | "right" | "top" | "bottom",
): SplitNode {
  return insertSplitInternal({
    root: asInternalNode(root),
    targetPaneId,
    tabId,
    position,
    createNodeId: generateNodeId,
  }).root;
}

export function removePaneFromTree(root: SplitNode, paneId: string): SplitNode {
  const internalRoot = asInternalNode(root);
  const panePath = findPanePathById(internalRoot, paneId);
  if (!panePath) {
    return root;
  }
  return removePaneByPath(internalRoot, panePath);
}

export function removeTabFromTree(root: SplitNode, tabId: string): SplitNode {
  return detachTabFromTree(asInternalNode(root), { tabId }).root;
}

function insertNewTabIntoFocusedPane(input: {
  layout: WorkspaceLayout;
  target: WorkspaceTabTarget;
  now: number;
  focus: boolean;
}): OpenTabInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const focusedPane =
    findPaneById(layout.root, layout.focusedPaneId) ??
    collectAllPanes(layout.root)[0] ??
    findPaneById(createDefaultLayout().root, DEFAULT_PANE_ID);
  invariant(focusedPane, "Workspace layout must always have a pane");

  const tabId = buildDeterministicWorkspaceTabId(input.target);
  const nextTab: WorkspaceTab = {
    tabId,
    target: input.target,
    createdAt: input.now,
  };

  const preservedFocusTabId = focusedPane.focusedTabId ?? tabId;

  return {
    tabId,
    layout: {
      root: insertTabIntoPane(layout.root, {
        paneId: focusedPane.id,
        tab: nextTab,
        focusTabId: input.focus ? tabId : preservedFocusTabId,
      }),
      focusedPaneId: input.focus ? focusedPane.id : layout.focusedPaneId,
    },
  };
}

export function openTabInLayoutFocused(input: OpenTabInLayoutInput): OpenTabInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const existingTab = collectAllTabs(layout.root).find((tab) =>
    workspaceTabTargetsEqual(tab.target, input.target),
  );
  if (existingTab) {
    return {
      tabId: existingTab.tabId,
      layout:
        focusTabInLayout({
          layout,
          tabId: existingTab.tabId,
        }) ?? input.layout,
    };
  }

  return insertNewTabIntoFocusedPane({ ...input, focus: true });
}

export function openTabInLayoutBackground(input: OpenTabInLayoutInput): OpenTabInLayoutResult {
  const layout = asInternalLayout(input.layout);
  const existingTab = collectAllTabs(layout.root).find((tab) =>
    workspaceTabTargetsEqual(tab.target, input.target),
  );
  if (existingTab) {
    return { tabId: existingTab.tabId, layout: input.layout };
  }

  return insertNewTabIntoFocusedPane({ ...input, focus: false });
}

export function closeTabInLayout(input: CloseTabInLayoutInput): WorkspaceLayout | null {
  const internalLayout = asInternalLayout(input.layout);
  const pane = findPaneContainingTab(internalLayout.root, input.tabId);
  if (!pane) {
    return null;
  }

  const fallbackPaneId = findNearestSiblingPaneId(internalLayout.root, pane.id);
  const nextRoot = removeTabFromTree(internalLayout.root, input.tabId) as SplitNodeInternal;
  const nextFocusedPaneId =
    findPaneById(nextRoot, internalLayout.focusedPaneId)?.id ??
    (fallbackPaneId && findPaneById(nextRoot, fallbackPaneId)?.id) ??
    collectAllPanes(nextRoot)[0]?.id ??
    DEFAULT_PANE_ID;

  return {
    root: nextRoot,
    focusedPaneId: nextFocusedPaneId,
  };
}

export function focusTabInLayout(input: FocusTabInLayoutInput): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  const pane = findPaneContainingTab(layout.root, input.tabId);
  if (!pane) {
    return null;
  }

  if (pane.focusedTabId === input.tabId && layout.focusedPaneId === pane.id) {
    return null;
  }

  return {
    root: focusTabInPane(layout.root, pane.id, input.tabId),
    focusedPaneId: pane.id,
  };
}

export function retargetTabInLayout(
  input: RetargetTabInLayoutInput,
): RetargetTabInLayoutResult | null {
  const layout = asInternalLayout(input.layout);
  const pane = findPaneContainingTab(layout.root, input.tabId);
  if (!pane) {
    return null;
  }

  const currentTab = collectAllTabs(layout.root).find((tab) => tab.tabId === input.tabId) ?? null;
  if (currentTab && workspaceTabTargetsEqual(currentTab.target, input.target)) {
    return {
      layout: input.layout,
      tabId: input.tabId,
    };
  }

  const existingTargetTab =
    collectAllTabs(layout.root).find(
      (tab) => tab.tabId !== input.tabId && workspaceTabTargetsEqual(tab.target, input.target),
    ) ?? null;
  if (existingTargetTab) {
    const nextLayout =
      closeTabInLayout({
        layout: input.layout,
        tabId: input.tabId,
      }) ?? input.layout;
    return {
      layout:
        focusTabInLayout({
          layout: nextLayout,
          tabId: existingTargetTab.tabId,
        }) ?? nextLayout,
      tabId: existingTargetTab.tabId,
    };
  }

  return {
    // Preserve the existing tab id so draft->entity transitions keep the same
    // React key during the first render. Reconciliation can canonicalize later.
    tabId: input.tabId,
    layout: {
      root: replaceTabInTree(layout.root, {
        tabId: input.tabId,
        nextTabId: input.tabId,
        target: input.target,
      }),
      focusedPaneId: layout.focusedPaneId,
    },
  };
}

export function convertDraftToAgentInLayout(
  input: ConvertDraftToAgentInLayoutInput,
): ConvertDraftToAgentInLayoutResult | null {
  const layout = asInternalLayout(input.layout);
  const currentTab = collectAllTabs(layout.root).find((tab) => tab.tabId === input.tabId) ?? null;
  if (!currentTab || currentTab.target.kind !== "draft") {
    return null;
  }

  const target: WorkspaceTabTarget = {
    kind: "agent",
    agentId: input.agentId,
  };
  const canonicalTabId = buildDeterministicWorkspaceTabId(target);
  const existingCanonicalTab =
    collectAllTabs(layout.root).find((tab) => tab.tabId === canonicalTabId) ?? null;

  if (existingCanonicalTab && existingCanonicalTab.tabId !== input.tabId) {
    const nextLayout =
      closeTabInLayout({
        layout: input.layout,
        tabId: input.tabId,
      }) ?? input.layout;
    return {
      layout:
        focusTabInLayout({
          layout: nextLayout,
          tabId: canonicalTabId,
        }) ?? nextLayout,
      tabId: canonicalTabId,
    };
  }

  return {
    tabId: canonicalTabId,
    layout: {
      root: replaceTabInTree(layout.root, {
        tabId: input.tabId,
        nextTabId: canonicalTabId,
        target,
      }),
      focusedPaneId: layout.focusedPaneId,
    },
  };
}

export function reorderFocusedPaneTabsInLayout(
  input: ReorderFocusedPaneTabsInLayoutInput,
): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  if (!findPaneById(layout.root, layout.focusedPaneId)) {
    return null;
  }

  return {
    root: updatePaneInTree(layout.root, {
      paneId: layout.focusedPaneId,
      updater: (pane) => reorderTabsForPane({ pane, tabIds: input.tabIds }),
    }),
    focusedPaneId: layout.focusedPaneId,
  };
}

export function splitPaneInLayout(input: SplitPaneInLayoutInput): SplitPaneInLayoutResult | null {
  const layout = asInternalLayout(input.layout);
  if (!findPaneById(layout.root, input.targetPaneId)) {
    return null;
  }
  if (!findPaneContainingTab(layout.root, input.tabId)) {
    return null;
  }

  const result = insertSplitInternal({
    root: layout.root,
    targetPaneId: input.targetPaneId,
    tabId: input.tabId,
    position: input.position,
    createNodeId: input.createNodeId,
  });
  if (getTreeDepth(result.root) > input.maxTreeDepth) {
    return null;
  }

  return {
    paneId: result.newPaneId,
    layout: {
      root: result.root,
      focusedPaneId: result.newPaneId,
    },
  };
}

export function splitPaneEmptyInLayout(
  input: SplitPaneEmptyInLayoutInput,
): SplitPaneInLayoutResult | null {
  const layout = asInternalLayout(input.layout);
  if (!findPaneById(layout.root, input.targetPaneId)) {
    return null;
  }

  const direction =
    input.position === "left" || input.position === "right" ? "horizontal" : "vertical";
  const insertAfter = input.position === "right" || input.position === "bottom";

  const targetPath = findPanePathById(layout.root, input.targetPaneId);
  invariant(targetPath, `Target pane not found: ${input.targetPaneId}`);
  const targetNode = getNodeAtPath(layout.root, targetPath);
  invariant(targetNode.kind === "pane", "Expected target pane");

  const newPaneId = input.createNodeId("pane");
  const newPaneNode = createPaneNode({ id: newPaneId });

  const parentPath = targetPath.slice(0, -1);
  const targetIndex = targetPath[targetPath.length - 1] ?? 0;
  const parentNode = parentPath.length > 0 ? getNodeAtPath(layout.root, parentPath) : null;

  let nextRoot: SplitNodeInternal;
  if (parentNode?.kind === "group" && parentNode.group.direction === direction) {
    const targetSize = parentNode.group.sizes[targetIndex] ?? 0;
    const nextSizes = parentNode.group.sizes.slice();
    const insertIndex = insertAfter ? targetIndex + 1 : targetIndex;
    nextSizes.splice(insertIndex, 0, targetSize / 2);
    nextSizes[targetIndex + (insertAfter ? 0 : 1)] = targetSize / 2;
    nextRoot = replaceNodeAtPath(layout.root, parentPath, () =>
      insertChildIntoGroup(parentNode, { index: insertIndex, node: newPaneNode, sizes: nextSizes }),
    );
  } else {
    const newGroup = createGroupNode({
      id: input.createNodeId("group"),
      direction,
      children: insertAfter ? [targetNode, newPaneNode] : [newPaneNode, targetNode],
      sizes: [0.5, 0.5],
    });
    nextRoot = replaceNodeAtPath(layout.root, targetPath, () => newGroup);
  }

  if (getTreeDepth(nextRoot) > input.maxTreeDepth) {
    return null;
  }

  return {
    paneId: newPaneId,
    layout: {
      root: nextRoot,
      focusedPaneId: newPaneId,
    },
  };
}

export function moveTabToPaneInLayout(input: MoveTabToPaneInLayoutInput): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  const sourcePane = findPaneContainingTab(layout.root, input.tabId);
  if (!sourcePane || !findPaneById(layout.root, input.toPaneId)) {
    return null;
  }

  const detached = detachTabFromTree(layout.root, {
    tabId: input.tabId,
    preserveEmptyPaneId: sourcePane.id === input.toPaneId ? input.toPaneId : null,
  });
  if (!detached.tab) {
    return null;
  }

  return {
    root: insertTabIntoPane(detached.root, {
      paneId: input.toPaneId,
      tab: detached.tab,
      focusTabId: input.tabId,
    }),
    focusedPaneId: input.toPaneId,
  };
}

export function focusPaneInLayout(input: FocusPaneInLayoutInput): WorkspaceLayout | null {
  if (!findPaneById(input.layout.root, input.paneId)) {
    return null;
  }
  if (input.layout.focusedPaneId === input.paneId) {
    return null;
  }
  return {
    root: input.layout.root,
    focusedPaneId: input.paneId,
  };
}

export function resizeSplitInLayout(input: ResizeSplitInLayoutInput): WorkspaceLayout {
  const layout = asInternalLayout(input.layout);
  return {
    root: updateGroupSizesInTree(layout.root, {
      groupId: input.groupId,
      sizes: input.sizes,
    }),
    focusedPaneId: layout.focusedPaneId,
  };
}

export function reorderPaneTabsInLayout(
  input: ReorderPaneTabsInLayoutInput,
): WorkspaceLayout | null {
  const layout = asInternalLayout(input.layout);
  if (!findPaneById(layout.root, input.paneId)) {
    return null;
  }

  return {
    root: updatePaneInTree(layout.root, {
      paneId: input.paneId,
      updater: (pane) => reorderTabsForPane({ pane, tabIds: input.tabIds }),
    }),
    focusedPaneId: layout.focusedPaneId,
  };
}

function normalizeStringSet(values: Iterable<string>): Set<string> {
  const next = new Set<string>();
  for (const value of values) {
    const normalized = trimNonEmpty(value);
    if (normalized) {
      next.add(normalized);
    }
  }
  return next;
}

function isEntityTarget(
  target: WorkspaceTabTarget,
): target is Extract<WorkspaceTabTarget, { kind: "agent" | "terminal" }> {
  return target.kind === "agent" || target.kind === "terminal";
}

function isAgentTab(
  tab: WorkspaceTab,
): tab is WorkspaceTab & { target: { kind: "agent"; agentId: string } } {
  return tab.target.kind === "agent";
}

function isTerminalTab(
  tab: WorkspaceTab,
): tab is WorkspaceTab & { target: { kind: "terminal"; terminalId: string } } {
  return tab.target.kind === "terminal";
}

function openEntityTabWithoutFocusing(
  layout: WorkspaceLayout,
  target: WorkspaceTabTarget,
): WorkspaceLayout {
  const internalLayout = asInternalLayout(layout);
  const focusedPane =
    findPaneById(internalLayout.root, internalLayout.focusedPaneId) ??
    collectAllPanes(internalLayout.root)[0] ??
    findPaneById(createDefaultLayout().root, DEFAULT_PANE_ID);
  invariant(focusedPane, "Workspace layout must always have a pane");

  const tabId = buildDeterministicWorkspaceTabId(target);
  return {
    root: insertTabIntoPane(internalLayout.root, {
      paneId: focusedPane.id,
      tab: {
        tabId,
        target,
        createdAt: Date.now(),
      },
      focusTabId: focusedPane.focusedTabId ?? tabId,
    }),
    focusedPaneId: internalLayout.focusedPaneId,
  };
}

export function reconcileWorkspaceTabs(
  state: WorkspaceTabReconcileState,
  snapshot: WorkspaceTabSnapshot,
): WorkspaceTabReconcileState {
  let nextLayout = state.layout;
  const originalFocusedTabId =
    findPaneById(nextLayout.root, nextLayout.focusedPaneId)?.focusedTabId ?? null;
  let reconciledFocusedTabId = originalFocusedTabId;
  const pinnedAgentIds = new Set(state.pinnedAgentIds ?? []);
  const hiddenAgentIds = new Set(state.hiddenAgentIds ?? []);
  const activeAgentIds = normalizeStringSet(snapshot.activeAgentIds);
  const knownAgentIds = normalizeStringSet(snapshot.knownAgentIds);
  const standaloneTerminalIds = normalizeStringSet(snapshot.standaloneTerminalIds);
  const knownTerminalIds = snapshot.knownTerminalIds
    ? normalizeStringSet(snapshot.knownTerminalIds)
    : standaloneTerminalIds;
  const visibleAgentIds = new Set(activeAgentIds);
  for (const agentId of pinnedAgentIds) {
    if (knownAgentIds.has(agentId)) {
      visibleAgentIds.add(agentId);
    }
  }
  for (const agentId of hiddenAgentIds) {
    visibleAgentIds.delete(agentId);
  }

  const initialTabs = collectAllTabs(nextLayout.root);
  const representedAgentIds = new Set(
    initialTabs.filter(isAgentTab).map((tab) => tab.target.agentId),
  );

  const entityGroups = new Map<
    string,
    {
      target: WorkspaceTabTarget;
      tabs: WorkspaceTab[];
    }
  >();
  for (const tab of initialTabs) {
    if (!isEntityTarget(tab.target)) {
      continue;
    }
    const canonicalTarget = normalizeWorkspaceTabTarget(tab.target);
    if (!canonicalTarget) {
      continue;
    }
    const canonicalTabId = buildDeterministicWorkspaceTabId(canonicalTarget);
    const currentGroup = entityGroups.get(canonicalTabId);
    if (currentGroup) {
      currentGroup.tabs.push(tab);
      continue;
    }
    entityGroups.set(canonicalTabId, {
      target: canonicalTarget,
      tabs: [tab],
    });
  }

  for (const [canonicalTabId, group] of entityGroups) {
    const keeper = group.tabs.find((tab) => tab.tabId === canonicalTabId) ?? group.tabs[0] ?? null;
    if (!keeper) {
      continue;
    }
    if (group.tabs.some((tab) => tab.tabId === originalFocusedTabId)) {
      reconciledFocusedTabId = canonicalTabId;
    }
    if (keeper.tabId !== canonicalTabId || !workspaceTabTargetsEqual(keeper.target, group.target)) {
      nextLayout = {
        root: replaceTabInTree(asInternalLayout(nextLayout).root, {
          tabId: keeper.tabId,
          nextTabId: canonicalTabId,
          target: group.target,
        }),
        focusedPaneId: nextLayout.focusedPaneId,
      };
    }
    for (const tab of group.tabs) {
      if (tab.tabId === keeper.tabId) {
        continue;
      }
      nextLayout =
        closeTabInLayout({
          layout: nextLayout,
          tabId: tab.tabId,
        }) ?? nextLayout;
    }
  }

  for (const tab of collectAllTabs(nextLayout.root)) {
    if (isAgentTab(tab) && snapshot.agentsHydrated && !visibleAgentIds.has(tab.target.agentId)) {
      nextLayout =
        closeTabInLayout({
          layout: nextLayout,
          tabId: tab.tabId,
        }) ?? nextLayout;
    }
    if (
      isTerminalTab(tab) &&
      snapshot.terminalsHydrated &&
      !knownTerminalIds.has(tab.target.terminalId)
    ) {
      nextLayout =
        closeTabInLayout({
          layout: nextLayout,
          tabId: tab.tabId,
        }) ?? nextLayout;
    }
  }

  const currentEntityTabs = collectAllTabs(nextLayout.root);
  const currentAgentIds = new Set(
    currentEntityTabs.filter(isAgentTab).map((tab) => tab.target.agentId),
  );
  const currentTerminalIds = new Set(
    currentEntityTabs.filter(isTerminalTab).map((tab) => tab.target.terminalId),
  );

  const sortedVisibleAgentIds = [...visibleAgentIds].sort();
  for (const agentId of sortedVisibleAgentIds) {
    if (currentAgentIds.has(agentId)) {
      continue;
    }
    if (snapshot.hasActivePendingDraftCreate && !representedAgentIds.has(agentId)) {
      continue;
    }
    nextLayout = openEntityTabWithoutFocusing(nextLayout, {
      kind: "agent",
      agentId,
    });
    currentAgentIds.add(agentId);
  }

  const sortedTerminalIds = [...standaloneTerminalIds].sort();
  for (const terminalId of sortedTerminalIds) {
    if (currentTerminalIds.has(terminalId)) {
      continue;
    }
    nextLayout = openEntityTabWithoutFocusing(nextLayout, {
      kind: "terminal",
      terminalId,
    });
    currentTerminalIds.add(terminalId);
  }

  if (reconciledFocusedTabId) {
    nextLayout =
      focusTabInLayout({
        layout: nextLayout,
        tabId: reconciledFocusedTabId,
      }) ?? nextLayout;
  }

  return {
    ...state,
    layout: nextLayout,
  };
}
