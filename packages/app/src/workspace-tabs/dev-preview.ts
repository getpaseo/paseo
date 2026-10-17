import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { openWorkspaceBrowser } from "@/workspace-tabs/browser";
import { trimNonEmpty } from "@/desktop/browser/store/state";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
  type SplitNode,
} from "@/stores/workspace-layout-store";

/**
 * The dev preview is an ordinary browser tab whose `WorkspaceTab.state` carries the service it
 * belongs to. The marker lives in tab state rather than a second persistence field so closing the
 * tab through the ordinary cleanup path is enough — nothing else to forget.
 */
const DEV_PREVIEW_MARKER_KEY = "devPreviewScriptName";

/** Share of the preview column inside its horizontal group: 25% conversation, 75% preview. */
const DEV_PREVIEW_PANE_SHARE = 0.75;

export function readWorkspaceDevPreviewScriptName(state: JsonValue | undefined): string | null {
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return null;
  }
  const value = (state as Record<string, unknown>)[DEV_PREVIEW_MARKER_KEY];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export interface WorkspaceDevPreviewTab {
  tabId: string;
  browserId: string;
}

export function findWorkspaceDevPreview(input: {
  workspaceKey: string;
  scriptName: string;
}): WorkspaceDevPreviewTab | null {
  const workspaceKey = trimNonEmpty(input.workspaceKey);
  const scriptName = trimNonEmpty(input.scriptName);
  if (!workspaceKey || !scriptName) {
    return null;
  }
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  if (!layout) {
    return null;
  }
  const tab = collectAllTabs(layout.root).find(
    (candidate) =>
      candidate.target.kind === "browser" &&
      readWorkspaceDevPreviewScriptName(candidate.state) === scriptName,
  );
  if (!tab || tab.target.kind !== "browser") {
    return null;
  }
  return { tabId: tab.tabId, browserId: tab.target.browserId };
}

interface DevPreviewColumnGroup {
  groupId: string;
  sizes: number[];
  paneIndex: number;
}

interface AncestorGroup {
  groupId: string;
  direction: "horizontal" | "vertical";
  sizes: number[];
  childIndex: number;
}

/**
 * The horizontal group whose resize puts the preview column at its share, and whether that column
 * is full height at all. A column under any vertical ancestor shares its height with something
 * else, so the 25/75 contract cannot be honored there without moving other content.
 */
function findFullHeightColumnGroup(input: {
  root: SplitNode;
  paneId: string;
}): DevPreviewColumnGroup | null {
  const visit = (node: SplitNode, ancestors: AncestorGroup[]): DevPreviewColumnGroup | null => {
    if (node.kind === "pane") {
      if (node.pane.id !== input.paneId || ancestors.length === 0) {
        return null;
      }
      const isFullHeight = ancestors.every((ancestor) => ancestor.direction === "horizontal");
      if (!isFullHeight) {
        return null;
      }
      const parent = ancestors[ancestors.length - 1];
      return { groupId: parent.groupId, sizes: parent.sizes, paneIndex: parent.childIndex };
    }
    let found: DevPreviewColumnGroup | null = null;
    for (let index = 0; index < node.group.children.length && !found; index += 1) {
      found = visit(node.group.children[index], [
        ...ancestors,
        {
          groupId: node.group.id,
          direction: node.group.direction,
          sizes: node.group.sizes,
          childIndex: index,
        },
      ]);
    }
    return found;
  };

  return visit(input.root, []);
}

function columnSizesGivingPaneShare(input: {
  sizes: number[];
  paneIndex: number;
  paneShare: number;
}): number[] {
  const othersTotal = input.sizes.reduce(
    (total, size, index) => (index === input.paneIndex ? total : total + size),
    0,
  );
  return input.sizes.map((size, index) => {
    if (index === input.paneIndex) {
      return input.paneShare;
    }
    if (othersTotal <= 0) {
      return (1 - input.paneShare) / Math.max(input.sizes.length - 1, 1);
    }
    return (size / othersTotal) * (1 - input.paneShare);
  });
}

export type OpenWorkspaceDevPreviewResult =
  | { ok: true; tabId: string; browserId: string; created: boolean }
  | { ok: false; reason: "no-side-pane" | "no-full-height-column" };

/**
 * Opens the service preview in the dedicated browser pane at 25/75.
 * Revealing an existing preview preserves its column share after browser placement.
 */
export function openWorkspaceDevPreview(input: {
  workspaceKey: string;
  scriptName: string;
  url: string;
}): OpenWorkspaceDevPreviewResult {
  const workspaceKey = trimNonEmpty(input.workspaceKey);
  const scriptName = trimNonEmpty(input.scriptName);
  const url = trimNonEmpty(input.url);
  if (!workspaceKey || !scriptName || !url) {
    return { ok: false, reason: "no-side-pane" };
  }

  const store = useWorkspaceLayoutStore.getState();
  const existing = findWorkspaceDevPreview({ workspaceKey, scriptName });
  const previousLayout = store.layoutByWorkspace[workspaceKey];
  const previousPane =
    existing && previousLayout ? findPaneContainingTab(previousLayout.root, existing.tabId) : null;
  const previousColumn = previousPane
    ? findFullHeightColumnGroup({ root: previousLayout.root, paneId: previousPane.id })
    : null;
  const previousSizes = previousColumn
    ? (store.splitSizesByWorkspace[workspaceKey]?.[previousColumn.groupId] ?? previousColumn.sizes)
    : null;
  const paneShare =
    previousColumn && previousSizes
      ? previousSizes[previousColumn.paneIndex]
      : DEV_PREVIEW_PANE_SHARE;

  const opened = openWorkspaceBrowser({
    workspaceKey,
    intent: "reveal",
    ...(existing
      ? { browserId: existing.browserId }
      : { url, state: { [DEV_PREVIEW_MARKER_KEY]: scriptName } }),
  });
  if (!opened.ok) return { ok: false, reason: "no-side-pane" };
  const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const pane = findPaneContainingTab(layout.root, opened.tabId);
  const column = pane ? findFullHeightColumnGroup({ root: layout.root, paneId: pane.id }) : null;
  if (!column) return { ok: false, reason: "no-full-height-column" };

  useWorkspaceLayoutStore.getState().resizeSplit(
    workspaceKey,
    column.groupId,
    columnSizesGivingPaneShare({
      sizes: column.sizes,
      paneIndex: column.paneIndex,
      paneShare,
    }),
  );

  return opened;
}
