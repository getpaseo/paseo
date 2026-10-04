import type { WorkspaceTabMenuEntry } from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * Move a workspace tab (agent sessions) into another workspace's tab row.
 *
 * The tab layout is client-side state keyed by `serverId:workspaceId`
 * (`buildWorkspaceTabPersistenceKey`), while an agent always *belongs* to the
 * workspace that created it. A moved tab therefore lives in the destination via
 * `pin: true` (an explicit open survives tab reconciliation) and leaves the
 * source via the same cleanup as closing a tab (`unpin` + `hide` + `close`), so
 * reconciliation does not re-open it there. The agent itself keeps running in
 * its original directory and stays under its original project in the sidebar.
 *
 * The picker mirrors the sidebar's project → workspace grouping
 * (`sidebar-workspaces-view-model`: `projectNameForWorkspace` and
 * `resolveSidebarWorkspacePrimaryLabel` semantics), so the move list reads the
 * same way as the left sidebar.
 */
export const MOVE_TO_WORKSPACE_MENU_KEY = "move-to-workspace";

/**
 * Daemon-synced label that records which workspace an agent tab was moved to.
 * Agent labels travel through `update_agent_request` and reach every client, so
 * patched clients converge on the same tab placement across devices. Use the
 * `paseo.` prefix like Paseo's own operational labels
 * (`paseo.open-agent-tab.*`, `paseo.parent-agent-id`).
 *
 * Sync discipline (the injected bundle wiring enforces this; see
 * server_setup/paseo-patches/patch-paseo-tab-move-workspace.py): user gestures
 * (open/close/move) write labels at action time; the periodic broadcast only
 * adopts tabs that carry no placement label and only writes order drift on
 * converged ones — it must never write a workspace/closed value that disagrees
 * with the label, or a not-yet-converged client would stomp another client's
 * in-flight move. Locally written labels are merged over the stored copy until
 * the daemon echo lands, so a gesture never snaps back for one tick.
 */
export const TAB_WORKSPACE_LABEL = "paseo.tab-workspace";

/** Zero-padded position of the agent tab inside its pane row. */
export const TAB_ORDER_LABEL = "paseo.tab-order";

/**
 * Daemon-synced close intent. The wire schema only accepts string values, so a
 * label can never be deleted client-side — `"1"` means "the user closed this
 * tab, close it everywhere", and `""` (written by any later open/move/broadcast)
 * reverts to open. Enforcement treats any non-empty value as closed, so a tab
 * the user closed is never resurrected by the reconciler.
 */
export const TAB_CLOSED_LABEL = "paseo.tab-closed";

/**
 * A label write this client just issued but the daemon has not echoed back
 * yet. `undefined` = the gesture did not touch that key.
 */
export interface PendingTabLabels {
  workspaceId?: string;
  closed?: boolean;
  order?: string;
}

/**
 * Merge local intent over the stored labels until the daemon echo lands.
 * Enforcement and broadcast must read this merged view: reading the raw
 * stored labels during the echo round-trip is what made a drag bounce back
 * for one tick (and let a not-yet-converged client stomp the in-flight move).
 */
export function mergePendingTabLabels(
  labels: Record<string, string> | null | undefined,
  pending: PendingTabLabels | undefined,
): Record<string, string> {
  if (!pending) {
    return { ...labels };
  }
  const merged = { ...labels };
  if (pending.workspaceId !== undefined) {
    merged[TAB_WORKSPACE_LABEL] = pending.workspaceId;
  }
  if (pending.closed !== undefined) {
    merged[TAB_CLOSED_LABEL] = pending.closed ? "1" : "";
  }
  if (pending.order !== undefined) {
    merged[TAB_ORDER_LABEL] = pending.order;
  }
  return merged;
}

/**
 * A pending write can be retired once the echoed labels carry every key it
 * wrote. Until then the stored copy may still hold the pre-gesture value.
 */
export function pendingTabLabelsSatisfied(
  pending: PendingTabLabels,
  labels: Record<string, string> | null | undefined,
): boolean {
  if (
    pending.workspaceId !== undefined &&
    (labels?.[TAB_WORKSPACE_LABEL] ?? "") !== pending.workspaceId
  ) {
    return false;
  }
  if (pending.closed !== undefined && Boolean(labels?.[TAB_CLOSED_LABEL]) !== pending.closed) {
    return false;
  }
  if (pending.order !== undefined && (labels?.[TAB_ORDER_LABEL] ?? "") !== pending.order) {
    return false;
  }
  return true;
}

export function formatTabOrderLabel(index: number): string {
  return String(Math.max(0, Math.floor(index))).padStart(6, "0");
}

export function parseTabOrderLabel(value: string | null | undefined): number | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(value);
}

/** Drop target: sidebar workspace rows carry `testID={prefix}{workspaceKey}`. */
export const SIDEBAR_WORKSPACE_ROW_TESTID_PREFIX = "sidebar-workspace-row-";

export function buildTabWorkspaceLabels(
  currentLabels: Readonly<Record<string, string>> | null | undefined,
  workspaceId: string,
  tabOrder?: number | null,
): Record<string, string> {
  return {
    ...currentLabels,
    [TAB_WORKSPACE_LABEL]: workspaceId.trim(),
    [TAB_CLOSED_LABEL]: "",
    ...(tabOrder == null ? {} : { [TAB_ORDER_LABEL]: formatTabOrderLabel(tabOrder) }),
  };
}

/** Close intent: keep the workspace label so a later reopen lands in place. */
export function buildTabClosedLabels(
  currentLabels: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  return { ...currentLabels, [TAB_CLOSED_LABEL]: "1" };
}

/**
 * Stable order for one pane's agent tabs: sort by the synced order label,
 * unlabeled tabs stay last in their current relative order. Non-agent tabs are
 * not in this list; the caller keeps their slots untouched.
 */
export function planTabOrderEnforcement(input: {
  agentTabIdsInSlots: readonly string[];
  orderLabelByTabId: Readonly<Record<string, string | null | undefined>>;
}): string[] {
  return [...input.agentTabIdsInSlots].sort((left, right) => {
    const a = parseTabOrderLabel(input.orderLabelByTabId[left]);
    const b = parseTabOrderLabel(input.orderLabelByTabId[right]);
    if (a == null && b == null) {
      return 0;
    }
    if (a == null) {
      return 1;
    }
    if (b == null) {
      return -1;
    }
    return a - b;
  });
}

/**
 * Whether the enforcer should close this agent's tabs.
 *
 * A synced close (`tombstone`) wins over pin, archive, and a tab that is
 * still open locally. This client must not clear that label: an unarchive
 * update often arrives together with another client's close, and rewriting
 * it to open would resurrect the tab everywhere. An in-flight open
 * (`pendingClosed === false`) is the only "open is newer" signal, and the
 * gesture already wrote the label, so the enforcer does not write it again.
 * A history restore pins an agent that is already archived and stays open.
 * The archive transition itself closes a moved tab — move also pins, so pin
 * alone must not keep a tab that just became archived.
 */
export function decideSyncedClose(input: {
  tombstone: boolean;
  archived: boolean;
  pendingClosed: boolean | null;
  pinned: boolean;
  justArchived: boolean;
}): { closed: boolean } {
  if (input.pendingClosed === true) {
    return { closed: true };
  }
  if (input.pendingClosed === false) {
    return { closed: false };
  }
  if (input.tombstone || input.justArchived) {
    return { closed: true };
  }
  if (input.archived && !input.pinned) {
    return { closed: true };
  }
  return { closed: false };
}

/**
 * Enforcement plan for the synced label: a closed tombstone wins over any
 * placement label (close the tab everywhere); otherwise close the agent tab
 * everywhere except the labeled target, and open it in the target when it is
 * missing there.
 */
export function planTabWorkspaceEnforcement(input: {
  targetWorkspaceKey: string | null;
  workspaceKeysWithTab: readonly string[];
  closed?: boolean;
}): { closeIn: string[]; ensureIn: string | null } {
  if (input.closed) {
    return { closeIn: [...input.workspaceKeysWithTab], ensureIn: null };
  }
  const targetWorkspaceKey = input.targetWorkspaceKey?.trim() || null;
  if (!targetWorkspaceKey) {
    return { closeIn: [], ensureIn: null };
  }
  return {
    closeIn: input.workspaceKeysWithTab.filter((key) => key !== targetWorkspaceKey),
    ensureIn: input.workspaceKeysWithTab.includes(targetWorkspaceKey) ? null : targetWorkspaceKey,
  };
}

export function resolveSidebarDropWorkspaceKey(testId: string | null | undefined): string | null {
  if (!testId || !testId.startsWith(SIDEBAR_WORKSPACE_ROW_TESTID_PREFIX)) {
    return null;
  }
  const workspaceKey = testId.slice(SIDEBAR_WORKSPACE_ROW_TESTID_PREFIX.length).trim();
  return workspaceKey || null;
}

/**
 * Host half of a `serverId:workspaceId` layout key. Returns null for a key with
 * no separator, so a malformed test id can never look like a same-host drop.
 */
export function workspaceKeyServerId(workspaceKey: string | null | undefined): string | null {
  if (typeof workspaceKey !== "string") {
    return null;
  }
  const separator = workspaceKey.indexOf(":");
  return separator > 0 ? workspaceKey.slice(0, separator) : null;
}

export type WorkspaceTabMoveTitleSource = "title" | "branch";

export interface WorkspaceTabMoveStrings {
  menuLabel: string;
  title: string;
  hint: string;
  empty: string;
}

const STRINGS_ZH: WorkspaceTabMoveStrings = {
  menuLabel: "挪到其他 Workspace…",
  title: "挪动到 Workspace",
  hint: "会话仍在原目录继续运行",
  empty: "没有其它 Workspace 可选",
};

const STRINGS_EN: WorkspaceTabMoveStrings = {
  menuLabel: "Move to workspace…",
  title: "Move tab to workspace",
  hint: "The agent keeps running in its original directory.",
  empty: "No other workspace available",
};

export function resolveWorkspaceTabMoveStrings(
  language: string | null | undefined,
): WorkspaceTabMoveStrings {
  return (language ?? "").toLowerCase().startsWith("zh") ? STRINGS_ZH : STRINGS_EN;
}

export interface WorkspaceTabMoveWorkspace {
  /** Persistence key from `buildWorkspaceTabPersistenceKey`. */
  workspaceKey: string;
  workspaceId: string;
  /** Sidebar project header: `projectCustomName ?? projectDisplayName ?? derived`. */
  projectName: string;
  name: string;
  currentBranch: string | null;
  /** Sidebar meta label: `worktreeSlug ?? shortenPath(workspaceDirectory)`. */
  workspaceDirectoryLabel: string;
  archiving: boolean;
}

export interface WorkspaceTabMoveSource {
  workspaceKey: string;
}

export interface WorkspaceTabMoveStore {
  openTab(input: {
    workspaceKey: string;
    target: WorkspaceTabTarget;
    intent: "reveal";
    pin: true;
  }): string | null;
  closeTab(workspaceKey: string, tabId: string): void;
  unpinAgent(workspaceKey: string, agentId: string): void;
  hideAgent(workspaceKey: string, agentId: string): void;
}

export interface WorkspaceTabMoveDeps {
  store: WorkspaceTabMoveStore;
  /** Daemon-synced placement write; omit when no client is connected. */
  updateAgentLabels?: (agentId: string, labels: Record<string, string>) => void;
}

/** Mirrors `resolveSidebarWorkspacePrimaryLabel`. */
export function resolveWorkspaceTabMoveRowLabel(input: {
  workspace: { name: string; currentBranch: string | null };
  titleSource: WorkspaceTabMoveTitleSource;
}): string {
  if (input.titleSource === "branch") {
    return input.workspace.currentBranch ?? input.workspace.name;
  }
  return input.workspace.name;
}

export interface WorkspaceTabMoveGroup {
  projectName: string;
  workspaces: WorkspaceTabMoveWorkspace[];
}

/** Groups targets by project name, preserving the sidebar's first-seen order. */
export function groupWorkspaceTabMoveTargets(
  workspaces: readonly WorkspaceTabMoveWorkspace[],
): WorkspaceTabMoveGroup[] {
  const groups: WorkspaceTabMoveGroup[] = [];
  const byProject = new Map<string, WorkspaceTabMoveGroup>();
  for (const workspace of workspaces) {
    let group = byProject.get(workspace.projectName);
    if (!group) {
      group = { projectName: workspace.projectName, workspaces: [] };
      byProject.set(workspace.projectName, group);
      groups.push(group);
    }
    group.workspaces.push(workspace);
  }
  return groups;
}

export function resolveWorkspaceTabMoveSource(input: {
  tabId: string;
  layouts: ReadonlyArray<{ workspaceKey: string; tabIds: readonly string[] }>;
}): WorkspaceTabMoveSource | null {
  const tabId = input.tabId.trim();
  if (!tabId) {
    return null;
  }
  for (const layout of input.layouts) {
    if (layout.tabIds.includes(tabId)) {
      return { workspaceKey: layout.workspaceKey };
    }
  }
  return null;
}

export function listWorkspaceTabMoveTargets(input: {
  sourceWorkspaceKey: string;
  workspaces: readonly WorkspaceTabMoveWorkspace[];
}): WorkspaceTabMoveWorkspace[] {
  return input.workspaces.filter(
    (workspace) =>
      workspace.workspaceKey !== input.sourceWorkspaceKey &&
      !workspace.archiving &&
      Boolean(workspace.workspaceKey.trim()),
  );
}

/** The menu hands us a `WorkspaceTabDescriptor`; both helpers only need these. */
export type WorkspaceTabLike = Pick<WorkspaceTab, "tabId" | "target">;

export function buildMoveToWorkspaceMenuEntry<TTab extends WorkspaceTabLike>(input: {
  tab: TTab;
  onSelect: (tab: TTab) => void;
  strings: Pick<WorkspaceTabMoveStrings, "menuLabel">;
}): WorkspaceTabMenuEntry | null {
  if (input.tab.target.kind !== "agent") {
    return null;
  }
  return {
    kind: "item",
    key: MOVE_TO_WORKSPACE_MENU_KEY,
    label: input.strings.menuLabel,
    testID: MOVE_TO_WORKSPACE_MENU_KEY,
    onSelect: () => {
      input.onSelect(input.tab);
    },
  };
}

/**
 * Inserts the move entry directly before the close group ("close-before"), or
 * appends it when that group is absent. Non-agent tabs are returned unchanged,
 * and an existing move entry is never duplicated.
 */
export function insertMoveToWorkspaceMenuEntry<TTab extends WorkspaceTabLike>(input: {
  entries: readonly WorkspaceTabMenuEntry[];
  tab: TTab;
  onSelect: (tab: TTab) => void;
  strings: Pick<WorkspaceTabMoveStrings, "menuLabel">;
}): WorkspaceTabMenuEntry[] {
  const entry = buildMoveToWorkspaceMenuEntry(input);
  if (!entry) {
    return [...input.entries];
  }
  const entries = [...input.entries];
  if (entries.some((candidate) => candidate.key === MOVE_TO_WORKSPACE_MENU_KEY)) {
    return entries;
  }
  const closeGroupIndex = entries.findIndex((candidate) => candidate.key === "close-before");
  if (closeGroupIndex === -1) {
    entries.push(entry);
    return entries;
  }
  entries.splice(closeGroupIndex, 0, entry);
  return entries;
}

export function moveWorkspaceTab(
  deps: WorkspaceTabMoveDeps,
  input: {
    sourceWorkspaceKey: string;
    targetWorkspaceKey: string;
    tabId: string;
    target: WorkspaceTabTarget;
    /** Descriptor id of the target workspace; enables the synced label write. */
    targetWorkspaceId?: string;
    agentLabels?: Readonly<Record<string, string>> | null;
  },
): boolean {
  const sourceWorkspaceKey = input.sourceWorkspaceKey.trim();
  const targetWorkspaceKey = input.targetWorkspaceKey.trim();
  const tabId = input.tabId.trim();
  if (!sourceWorkspaceKey || !targetWorkspaceKey || !tabId) {
    return false;
  }
  if (sourceWorkspaceKey === targetWorkspaceKey) {
    return false;
  }
  if (input.target.kind !== "agent") {
    return false;
  }
  const { agentId } = input.target;
  const opened = deps.store.openTab({
    workspaceKey: targetWorkspaceKey,
    target: { kind: "agent", agentId },
    intent: "reveal",
    pin: true,
  });
  if (!opened) {
    return false;
  }
  deps.store.unpinAgent(sourceWorkspaceKey, agentId);
  deps.store.hideAgent(sourceWorkspaceKey, agentId);
  deps.store.closeTab(sourceWorkspaceKey, tabId);
  const targetWorkspaceId = input.targetWorkspaceId?.trim();
  if (deps.updateAgentLabels && targetWorkspaceId) {
    deps.updateAgentLabels(agentId, buildTabWorkspaceLabels(input.agentLabels, targetWorkspaceId));
  }
  return true;
}
