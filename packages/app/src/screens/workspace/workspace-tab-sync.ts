import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { collectAllPanes, collectAllTabs } from "@/stores/workspace-layout-actions";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { buildDeterministicWorkspaceTabId } from "@/workspace-tabs/identity";
import {
  buildTabClosedLabels,
  buildTabWorkspaceLabels,
  decideSyncedClose,
  formatTabOrderLabel,
  mergePendingTabLabels,
  moveWorkspaceTab,
  planTabOrderEnforcement,
  planTabWorkspaceEnforcement,
  remainingPendingTabLabels,
  TAB_CLOSED_LABEL,
  TAB_ORDER_LABEL,
  TAB_WORKSPACE_LABEL,
  type PendingTabLabels,
} from "./workspace-tab-move";

/**
 * Cross-client sync engine for agent tab placement.
 *
 * The workspace tab layout is client-local state, so no daemon push can move a
 * tab on another machine — execution has to live on each client. The daemon
 * only carries intent through three agent labels (`paseo.tab-workspace`,
 * `paseo.tab-order`, `paseo.tab-closed`); this engine is the reader and writer
 * of that intent:
 *
 * - User gestures write at action time: the store's `openTab`/`closeTab` are
 *   wrapped so opening an agent tab writes its placement and clears the close
 *   tombstone, while closing one writes the tombstone.
 * - Remote intent lands in the session store through `agent_state` broadcasts:
 *   a subscription diffs the three sync labels and `archivedAt` per agent and
 *   applies convergent changes the moment they arrive — no polling on the hot path.
 * - Local layout changes publish the order labels through a debounced layout
 *   subscription.
 * - A slow sweep (30s) remains only as a backstop for lazily mounted layouts,
 *   missed edges and hook retries.
 *
 * Echo discipline keeps gestures from bouncing: every local label write is
 * remembered in `pendingLabels` and merged over the stored labels until that
 * field's daemon echo lands (or 15s elapse). Each field is dropped on its own
 * echo so a satisfied workspace cannot overlay a newer remote move while
 * order is still waiting. The sweep never writes a workspace/closed/order
 * value that disagrees with the label — a client that has not converged yet
 * must not stomp another client's in-flight change.
 *
 * Vanilla clients (without this engine) simply ignore the labels: their
 * open/close stays local and is not synced.
 */

const PENDING_LABEL_TTL_MS = 15_000;
const SWEEP_INTERVAL_MS = 30_000;
const LAYOUT_PUBLISH_DEBOUNCE_MS = 150;

/** Each written field ages on its own clock: a fresh order publish must not
 * extend the suppression window of an earlier workspace/closed intent.
 * `inFlightOrders` is the FIFO of order values this client wrote that have
 * not yet been observed in the stored labels, so an undo can keep overlaying
 * and republishing while an older write is still echoing. An echo of a rank
 * retires every queued copy of that rank; a satisfied order is not kept just
 * because duplicate publishes remain. */
interface PendingTabLabelWrite {
  workspaceId?: { value: string; at: number };
  closed?: { value: boolean; at: number };
  order?: { value: string; at: number };
  inFlightOrders?: string[];
  lastSeenStoredOrder?: string;
}

let internalSync = false;
const pendingLabels = new Map<string, PendingTabLabelWrite>();

type WorkspaceLayoutStoreApi = typeof useWorkspaceLayoutStore;
let activeWorkspaceLayoutStore: WorkspaceLayoutStoreApi = useWorkspaceLayoutStore;

function pendingKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

function markPending(serverId: string, agentId: string, patch: PendingTabLabels): void {
  const key = pendingKey(serverId, agentId);
  // Merge, not replace: an order publish landing while a move/close write is
  // still in flight must keep the earlier workspaceId/closed intent, or the
  // next pass reads the stale label and snaps the tab back. Every field keeps
  // its own timestamp so a later patch cannot refresh an older one's TTL.
  const next = { ...pendingLabels.get(key) };
  const at = Date.now();
  if (patch.workspaceId !== undefined) {
    next.workspaceId = { value: patch.workspaceId, at };
  }
  if (patch.closed !== undefined) {
    next.closed = { value: patch.closed, at };
  }
  if (patch.order !== undefined) {
    next.order = { value: patch.order, at };
  }
  pendingLabels.set(key, next);
}

function trackInFlightOrder(serverId: string, agentId: string, order: string): void {
  const key = pendingKey(serverId, agentId);
  const next = { ...pendingLabels.get(key) };
  next.inFlightOrders = [...(next.inFlightOrders ?? []), order];
  pendingLabels.set(key, next);
}

function acknowledgeOrderEcho(
  pending: PendingTabLabelWrite,
  stored: Record<string, string> | null,
): PendingTabLabelWrite {
  const storedOrder = stored?.[TAB_ORDER_LABEL] ?? "";
  const lastSeen = pending.lastSeenStoredOrder ?? "";
  const inFlightOrders = pending.inFlightOrders ?? [];
  if (storedOrder === lastSeen) {
    // A later echo of the same rank is a duplicate publish settling, not a
    // new value. Drop every queued copy of that rank.
    if (inFlightOrders.length > 0 && inFlightOrders.every((value) => value === storedOrder)) {
      return { ...pending, inFlightOrders: [] };
    }
    return pending;
  }
  return {
    ...pending,
    inFlightOrders: inFlightOrders.filter((value) => value !== storedOrder),
    lastSeenStoredOrder: storedOrder,
  };
}

function olderOrderWriteInFlight(
  pending: PendingTabLabelWrite | undefined,
  order: string,
): boolean {
  return (pending?.inFlightOrders ?? []).some((value) => value !== order);
}

/** Pending values that are neither satisfied nor expired, as plain labels. */
function livePendingFields(
  pending: PendingTabLabelWrite,
  stored: Record<string, string> | null,
): PendingTabLabels {
  const unexpired: PendingTabLabels = {};
  if (pending.workspaceId && Date.now() - pending.workspaceId.at <= PENDING_LABEL_TTL_MS) {
    unexpired.workspaceId = pending.workspaceId.value;
  }
  if (pending.closed && Date.now() - pending.closed.at <= PENDING_LABEL_TTL_MS) {
    unexpired.closed = pending.closed.value;
  }
  if (pending.order && Date.now() - pending.order.at <= PENDING_LABEL_TTL_MS) {
    unexpired.order = pending.order.value;
  }
  const remaining = remainingPendingTabLabels(unexpired, stored);
  // An undone order can match the stored labels while an older write is still
  // in flight. Keep overlaying it so that echo cannot restore the undone rank.
  if (
    remaining.order === undefined &&
    unexpired.order !== undefined &&
    olderOrderWriteInFlight(pending, unexpired.order)
  ) {
    remaining.order = unexpired.order;
  }
  return remaining;
}

function retainLivePendingWrite(
  pending: PendingTabLabelWrite,
  live: PendingTabLabels,
): PendingTabLabelWrite | null {
  const next: PendingTabLabelWrite = {};
  if (live.workspaceId !== undefined && pending.workspaceId) {
    next.workspaceId = pending.workspaceId;
  }
  if (live.closed !== undefined && pending.closed) {
    next.closed = pending.closed;
  }
  if (live.order !== undefined && pending.order) {
    next.order = pending.order;
  }
  // Only keep in-flight writes while the local order is still live. A
  // satisfied order whose remaining queue is duplicates of the echoed rank
  // has settled and must not overlay a newer remote order.
  if (live.order !== undefined && pending.inFlightOrders?.length) {
    next.inFlightOrders = [...pending.inFlightOrders];
  }
  if (
    next.workspaceId === undefined &&
    next.closed === undefined &&
    next.order === undefined &&
    !next.inFlightOrders?.length
  ) {
    return null;
  }
  next.lastSeenStoredOrder = pending.lastSeenStoredOrder;
  return next;
}

function agentLabelsFor(serverId: string, agentId: string): Record<string, string> | null {
  const session = useSessionStore.getState().sessions[serverId];
  const agent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
  return agent?.labels ?? null;
}

function effectiveLabels(serverId: string, agentId: string): Record<string, string> {
  const current = agentLabelsFor(serverId, agentId);
  const key = pendingKey(serverId, agentId);
  const pending = pendingLabels.get(key);
  if (!pending) {
    return current ?? {};
  }
  const acknowledged = acknowledgeOrderEcho(pending, current);
  const live = livePendingFields(acknowledged, current);
  const retained = retainLivePendingWrite(acknowledged, live);
  if (!retained) {
    pendingLabels.delete(key);
    return current ?? {};
  }
  // Drop each satisfied/expired field now. Keeping a workspace that already
  // echoed would overlay it again if another client moves the tab while a
  // different field (order) is still waiting. In-flight order writes stay
  // until their echo is observed, so an undo is not dropped just because it
  // matches the pre-echo stored labels.
  pendingLabels.set(key, retained);
  return mergePendingTabLabels(current, live);
}

/**
 * Whether the synced labels currently say this agent's tab is closed. A close
 * that lands while a drag gesture or a move menu is open must win over the
 * gesture: completing the move would clear the tombstone and resurrect a tab
 * the user (or another client) just closed. Local pending opens are included
 * through {@link effectiveLabels}, so a just-opened tab still moves.
 */
export function isAgentTabClosedBySync(serverId: string, agentId: string): boolean {
  // Read the pending-merged view so the engine keeps one precedence rule: a
  // local open that has not echoed yet (`closed: false` pending) is newer than
  // a stored tombstone and keeps the tab movable, exactly like
  // `decideSyncedClose` keeps it open. A stale gesture against a close that
  // already landed — no newer local open — is refused.
  return Boolean(effectiveLabels(serverId, agentId)[TAB_CLOSED_LABEL]);
}

interface TabSyncClient {
  updateAgent(agentId: string, updates: { labels: Record<string, string> }): unknown;
}

const defaultClientResolver = (serverId: string): TabSyncClient | null =>
  getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;

let clientResolver: (serverId: string) => TabSyncClient | null = defaultClientResolver;

/** Tests inject a fake daemon client here; production uses the runtime store. */
export function setWorkspaceTabSyncClientResolver(
  resolver: ((serverId: string) => TabSyncClient | null) | null,
): void {
  clientResolver = resolver ?? defaultClientResolver;
  // Each test installs a resolver. Drop the archive bit and in-flight writes
  // so one case cannot make the next case treat a move-pin as a fresh open.
  pendingLabels.clear();
  lastArchived.clear();
}

function writeAgentLabels(serverId: string, agentId: string, labels: Record<string, string>): void {
  try {
    const client = clientResolver(serverId);
    if (!client) {
      return;
    }
    void client.updateAgent(agentId, { labels });
  } catch {
    // Label sync is best-effort; the sweep converges what it can.
  }
}

function workspaceIdFromKey(workspaceKey: string): string {
  const separator = workspaceKey.indexOf(":");
  return separator > 0 ? workspaceKey.slice(separator + 1) : "";
}

function findAgentTab(workspaceKey: string, tabId: string) {
  const layout = activeWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  if (!layout) {
    return null;
  }
  return collectAllTabs(layout.root).find((tab) => tab.tabId === tabId) ?? null;
}

function eachSessionAgent(serverId: string, visit: (agentId: string, agent: Agent) => void): void {
  const session = useSessionStore.getState().sessions[serverId];
  const seen = new Set<string>();
  for (const map of [session?.agents, session?.agentDetails]) {
    if (!map) {
      continue;
    }
    for (const [agentId, agent] of map.entries()) {
      if (seen.has(agentId)) {
        continue;
      }
      seen.add(agentId);
      visit(agentId, agent);
    }
  }
}

/** Every workspace layout (same server) that currently hosts `agentId`. */
function findAgentTabCopies(
  serverId: string,
  agentId: string,
): { workspaceKeysWithTab: string[]; tabIdByWorkspaceKey: Map<string, string> } {
  const workspaceKeysWithTab: string[] = [];
  const tabIdByWorkspaceKey = new Map<string, string>();
  const layoutState = activeWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(layoutState.layoutByWorkspace ?? {})) {
    if (!workspaceKey.startsWith(`${serverId}:`)) {
      continue;
    }
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind === "agent" && tab.target.agentId === agentId) {
        workspaceKeysWithTab.push(workspaceKey);
        tabIdByWorkspaceKey.set(workspaceKey, tab.tabId);
      }
    }
  }
  return { workspaceKeysWithTab, tabIdByWorkspaceKey };
}

function pendingClosedValue(serverId: string, agentId: string): boolean | null {
  const pending = pendingLabels.get(pendingKey(serverId, agentId))?.closed;
  if (!pending || Date.now() - pending.at > PENDING_LABEL_TTL_MS) {
    return null;
  }
  return pending.value;
}

function agentIsPinned(serverId: string, agentId: string): boolean {
  const prefix = `${serverId}:`;
  for (const [workspaceKey, agentIds] of Object.entries(
    activeWorkspaceLayoutStore.getState().pinnedAgentIdsByWorkspace,
  )) {
    if (workspaceKey.startsWith(prefix) && agentIds.has(agentId)) {
      return true;
    }
  }
  return false;
}

/** Previous archived bit. Only the false → true edge closes a pinned moved tab. */
const lastArchived = new Map<string, boolean>();

function takeJustArchived(serverId: string, agentId: string, archived: boolean): boolean {
  const key = pendingKey(serverId, agentId);
  const seen = lastArchived.has(key);
  const wasArchived = lastArchived.get(key) === true;
  lastArchived.set(key, archived);
  return seen && !wasArchived && archived;
}

function enforceSyncedAgent(serverId: string, agentId: string, agent?: Agent): void {
  const labels = effectiveLabels(serverId, agentId);
  const workspaceId =
    typeof labels[TAB_WORKSPACE_LABEL] === "string" ? labels[TAB_WORKSPACE_LABEL] : "";
  const { workspaceKeysWithTab, tabIdByWorkspaceKey } = findAgentTabCopies(serverId, agentId);
  const archived = Boolean(agent?.archivedAt);
  // A synced close wins over pin and over an unarchive that arrived in the
  // same update. Do not clear that label from here. Archive closes a moved
  // tab; a history open is an in-flight `closed: false` or a pin on an agent
  // that was already archived.
  const closed = decideSyncedClose({
    tombstone: Boolean(labels[TAB_CLOSED_LABEL]),
    archived,
    pendingClosed: pendingClosedValue(serverId, agentId),
    pinned: agentIsPinned(serverId, agentId),
    justArchived: takeJustArchived(serverId, agentId, archived),
  }).closed;
  if (!workspaceId && !closed) {
    return;
  }
  const targetWorkspaceKey = workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId, workspaceId })
    : null;
  if (!targetWorkspaceKey && !closed) {
    return;
  }
  const plan = planTabWorkspaceEnforcement({
    targetWorkspaceKey,
    workspaceKeysWithTab,
    closed,
  });
  if (plan.closeIn.length === 0 && !plan.ensureIn && closed) {
    return;
  }
  const store = activeWorkspaceLayoutStore.getState();
  internalSync = true;
  try {
    if (!closed) {
      for (const workspaceKey of workspaceKeysWithTab) {
        store.unhideAgent(workspaceKey, agentId);
      }
    }
    for (const workspaceKey of plan.closeIn) {
      const tabId = tabIdByWorkspaceKey.get(workspaceKey);
      store.unpinAgent(workspaceKey, agentId);
      store.hideAgent(workspaceKey, agentId);
      if (tabId) {
        store.closeTab(workspaceKey, tabId);
      }
    }
    if (plan.ensureIn) {
      store.openTab({
        workspaceKey: plan.ensureIn,
        target: { kind: "agent", agentId },
        intent: "reveal",
        pin: true,
      });
    }
  } finally {
    internalSync = false;
  }
}

/**
 * Converge the local layout on the synced labels: a closed tombstone closes
 * the tab everywhere; otherwise the tab lives in the labeled workspace and
 * stale copies elsewhere are hidden/closed like a user close.
 */
function enforceSyncedTabs(): void {
  try {
    const sessions = useSessionStore.getState().sessions;
    for (const serverId of Object.keys(sessions)) {
      eachSessionAgent(serverId, (agentId, agent) => enforceSyncedAgent(serverId, agentId, agent));
    }
  } catch {
    // Best-effort convergence; the next sweep retries.
  }
}

/**
 * Per-pane order convergence: agent tabs take the labeled rank order inside
 * the slots they already occupy, so non-agent tabs never move.
 */
function enforceTabOrder(): void {
  try {
    const layoutState = activeWorkspaceLayoutStore.getState();
    for (const [workspaceKey, layout] of Object.entries(layoutState.layoutByWorkspace ?? {})) {
      const serverId = workspaceKey.slice(0, workspaceKey.indexOf(":"));
      const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
      for (const pane of collectAllPanes(layout.root)) {
        const tabIds = pane?.tabIds ?? [];
        const slots: number[] = [];
        const agentTabIds: string[] = [];
        const orderLabelByTabId: Record<string, string | null> = {};
        tabIds.forEach((tabId, index) => {
          const tab = tabsById.get(tabId);
          if (tab?.target.kind !== "agent") {
            return;
          }
          slots.push(index);
          agentTabIds.push(tabId);
          orderLabelByTabId[tabId] =
            effectiveLabels(serverId, tab.target.agentId)[TAB_ORDER_LABEL] ?? null;
        });
        if (slots.length < 2) {
          continue;
        }
        const desired = planTabOrderEnforcement({
          agentTabIdsInSlots: agentTabIds,
          orderLabelByTabId,
        });
        if (desired.every((tabId, index) => tabId === agentTabIds[index])) {
          continue;
        }
        const next = [...tabIds];
        slots.forEach((slot, index) => {
          next[slot] = desired[index];
        });
        internalSync = true;
        try {
          activeWorkspaceLayoutStore.getState().reorderTabsInPane(workspaceKey, pane.id, next);
        } finally {
          internalSync = false;
        }
      }
    }
  } catch {
    // Best-effort ordering; the next sweep retries.
  }
}

/**
 * Publish local tab state to the daemon labels so other devices follow. Order
 * is written only on the `publishLocal` path — the layout watcher after a real
 * local change. The sweep passes `false`, so it may adopt never-synced tabs
 * but never pushes a stale order over a remote change.
 */
function broadcastAgentTab(input: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  rank: number;
  publishLocal: boolean;
}): void {
  const { serverId, workspaceId, agentId, rank, publishLocal } = input;
  const effective = effectiveLabels(serverId, agentId);
  const labeledWorkspaceId = effective[TAB_WORKSPACE_LABEL];
  const order = formatTabOrderLabel(rank);
  if (!labeledWorkspaceId) {
    // Never synced: adopt the tab under the focused window's layout.
    markPending(serverId, agentId, { workspaceId, closed: false, order });
    trackInFlightOrder(serverId, agentId, order);
    writeAgentLabels(serverId, agentId, buildTabWorkspaceLabels(effective, workspaceId, rank));
    return;
  }
  if (!publishLocal || labeledWorkspaceId !== workspaceId) {
    return;
  }
  // Compare against the stored order, not the pending-merged view: a local
  // drag is marked pending before the debounced write, so `effective` already
  // matches the new rank and must not skip the publish. An undo that matches
  // the stored order still has to write if an older order write is in flight.
  const pending = pendingLabels.get(pendingKey(serverId, agentId));
  const storedOrder = agentLabelsFor(serverId, agentId)?.[TAB_ORDER_LABEL];
  if (storedOrder === order && !olderOrderWriteInFlight(pending, order)) {
    return;
  }
  const inFlightOrders = pending?.inFlightOrders ?? [];
  if (inFlightOrders[inFlightOrders.length - 1] === order) {
    return;
  }
  // Placement converged: write back only the order drift, marking it pending
  // so the enforcer cannot yank a fresh drag back to the stale label order.
  markPending(serverId, agentId, { order });
  trackInFlightOrder(serverId, agentId, order);
  writeAgentLabels(serverId, agentId, { ...effective, [TAB_ORDER_LABEL]: order });
}

function visitServerAgentTabs(
  serverId: string,
  visit: (input: { workspaceId: string; agentId: string; rank: number }) => void,
): void {
  const session = useSessionStore.getState().sessions[serverId];
  const agentById = new Map<string, Agent>([
    ...(session?.agentDetails?.entries() ?? []),
    ...(session?.agents?.entries() ?? []),
  ]);
  const layoutState = activeWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(layoutState.layoutByWorkspace ?? {})) {
    if (!workspaceKey.startsWith(`${serverId}:`)) {
      continue;
    }
    const workspaceId = workspaceKey.slice(serverId.length + 1);
    const tabsById = new Map(collectAllTabs(layout.root).map((tab) => [tab.tabId, tab]));
    for (const pane of collectAllPanes(layout.root)) {
      let rank = 0;
      for (const tabId of pane?.tabIds ?? []) {
        const tab = tabsById.get(tabId);
        if (tab?.target.kind !== "agent") {
          continue;
        }
        const agent = agentById.get(tab.target.agentId);
        if (agent) {
          visit({
            workspaceId,
            agentId: agent.id || tab.target.agentId,
            rank,
          });
          rank += 1;
        }
      }
    }
  }
}

function isFocusedWindow(): boolean {
  if (typeof document === "undefined" || typeof document.hasFocus !== "function") {
    return true;
  }
  return document.hasFocus();
}

/** Pin the current local ranks before the delayed write, so a remote echo
 * that lands in the debounce window cannot restore the old order. */
function rememberLocalTabOrder(): void {
  if (!isFocusedWindow()) {
    return;
  }
  for (const serverId of Object.keys(useSessionStore.getState().sessions)) {
    visitServerAgentTabs(serverId, ({ workspaceId, agentId, rank }) => {
      const order = formatTabOrderLabel(rank);
      const effective = effectiveLabels(serverId, agentId);
      if (effective[TAB_WORKSPACE_LABEL] !== workspaceId || effective[TAB_ORDER_LABEL] === order) {
        return;
      }
      markPending(serverId, agentId, { order });
    });
  }
}

function broadcastServerTabs(serverId: string, publishLocal: boolean): void {
  visitServerAgentTabs(serverId, ({ workspaceId, agentId, rank }) => {
    broadcastAgentTab({
      serverId,
      workspaceId,
      agentId,
      rank,
      publishLocal,
    });
  });
}

function broadcastTabs(publishLocal: boolean): void {
  try {
    if (!isFocusedWindow()) {
      return;
    }
    for (const serverId of Object.keys(useSessionStore.getState().sessions)) {
      broadcastServerTabs(serverId, publishLocal);
    }
  } catch {
    // Best-effort publish; the next sweep retries.
  }
}

/**
 * Move an agent tab into another workspace: open+pin in the target, then
 * unpin/hide/close in the source — the same cleanup the reconciler respects.
 * The placement label is written immediately and marked pending so the local
 * enforcer does not snap the tab back during the echo round-trip.
 */
export function moveAgentTabToWorkspace(input: {
  serverId: string;
  sourceWorkspaceKey: string;
  targetWorkspaceKey: string;
  targetWorkspaceId: string;
  agentId: string;
  tabId: string;
}): boolean {
  // The gesture may predate a close that has since landed (a drag started
  // before another client closed the tab, or a menu opened on a tab that is
  // now closed). Moving would write `closed: ""` and reopen it everywhere.
  if (isAgentTabClosedBySync(input.serverId, input.agentId)) {
    return false;
  }
  const store = activeWorkspaceLayoutStore.getState();
  let moved = false;
  internalSync = true;
  try {
    moved = moveWorkspaceTab(
      {
        store,
        updateAgentLabels: (agentId, labels) => {
          markPending(input.serverId, agentId, {
            workspaceId: input.targetWorkspaceId,
            closed: false,
          });
          writeAgentLabels(input.serverId, agentId, labels);
        },
      },
      {
        sourceWorkspaceKey: input.sourceWorkspaceKey,
        targetWorkspaceKey: input.targetWorkspaceKey,
        targetWorkspaceId: input.targetWorkspaceId,
        tabId: input.tabId,
        target: { kind: "agent", agentId: input.agentId },
        agentLabels: agentLabelsFor(input.serverId, input.agentId),
      },
    );
  } finally {
    internalSync = false;
  }
  if (moved) {
    enforceSyncedTabs();
  }
  return moved;
}

/**
 * Resolve the tab chip `data-testid="workspace-tab-<identity>"` suffix back to
 * the live tab: deterministic target ids and plain tab ids both match (the row
 * uses the deterministic id for every tab kind except `new_tab`).
 */
export function findAgentTabByTestIdentity(
  identity: string,
  preferredWorkspaceKey?: string | null,
): {
  workspaceKey: string;
  tabId: string;
  agentId: string;
} | null {
  const suffix = identity.trim();
  if (!suffix) {
    return null;
  }
  const matches: { workspaceKey: string; tabId: string; agentId: string }[] = [];
  const layoutState = activeWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(layoutState.layoutByWorkspace ?? {})) {
    for (const tab of collectAllTabs(layout.root)) {
      if (tab.target.kind !== "agent") {
        continue;
      }
      if (tab.tabId === suffix || buildDeterministicWorkspaceTabId(tab.target) === suffix) {
        matches.push({
          workspaceKey,
          tabId: tab.tabId,
          agentId: tab.target.agentId,
        });
      }
    }
  }
  // While a remote move is still converging, the same agent id can exist in
  // two layouts with identical chip ids — prefer the copy in the workspace
  // the user is actually dragging out of instead of an arbitrary match.
  return (
    matches.find((match) => match.workspaceKey === preferredWorkspaceKey) ?? matches[0] ?? null
  );
}

/** Locate which workspace layout currently hosts an agent tab. */
export function findAgentTabWorkspaceKey(agentId: string): string | null {
  const layoutState = activeWorkspaceLayoutStore.getState();
  for (const [workspaceKey, layout] of Object.entries(layoutState.layoutByWorkspace ?? {})) {
    if (
      collectAllTabs(layout.root).some(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === agentId,
      )
    ) {
      return workspaceKey;
    }
  }
  return null;
}

let hooksInstalled = false;
let sessionWatchInstalled = false;
let layoutWatchInstalled = false;
let sweepStarted = false;

/**
 * Wrap the store's openTab/closeTab so user gestures write labels at action
 * time instead of waiting for a broadcast: opening an agent tab records its
 * placement and clears the close tombstone, closing one writes the tombstone.
 * The engine's own open/close runs under `internalSync` and never writes.
 */
function installStoreHooks(): void {
  if (hooksInstalled) {
    return;
  }
  try {
    const state = activeWorkspaceLayoutStore.getState();
    const originalOpenTab = state.openTab;
    const originalCloseTab = state.closeTab;
    activeWorkspaceLayoutStore.setState({
      openTab(input) {
        const result = originalOpenTab.call(this, input);
        try {
          if (!internalSync && result && input.target?.kind === "agent" && input.workspaceKey) {
            const serverId = input.workspaceKey.slice(0, input.workspaceKey.indexOf(":"));
            const workspaceId = workspaceIdFromKey(input.workspaceKey);
            if (serverId && workspaceId) {
              markPending(serverId, input.target.agentId, {
                workspaceId,
                closed: false,
              });
              writeAgentLabels(
                serverId,
                input.target.agentId,
                buildTabWorkspaceLabels(
                  agentLabelsFor(serverId, input.target.agentId),
                  workspaceId,
                ),
              );
            }
          }
        } catch {
          // Label sync is best-effort; never break the open.
        }
        return result;
      },
      closeTab(workspaceKey, tabId) {
        try {
          if (!internalSync) {
            const tab = findAgentTab(workspaceKey, tabId);
            if (tab?.target.kind === "agent") {
              const serverId = workspaceKey.slice(0, workspaceKey.indexOf(":"));
              if (serverId) {
                markPending(serverId, tab.target.agentId, { closed: true });
                writeAgentLabels(
                  serverId,
                  tab.target.agentId,
                  buildTabClosedLabels(agentLabelsFor(serverId, tab.target.agentId)),
                );
              }
            }
          }
        } catch {
          // Label sync is best-effort; never break the close.
        }
        return originalCloseTab.call(this, workspaceKey, tabId);
      },
    });
    hooksInstalled = true;
  } catch {
    // The next sweep retries the install.
  }
}

function syncLabelSignature(
  labels: Record<string, string> | null | undefined,
  archived: boolean,
): string {
  return [
    labels?.[TAB_WORKSPACE_LABEL] ?? "",
    labels?.[TAB_ORDER_LABEL] ?? "",
    labels?.[TAB_CLOSED_LABEL] ?? "",
    archived ? "1" : "0",
  ].join("|");
}

/**
 * Remote label writes land in the session store through `agent_state`
 * broadcasts, so a subscription applies moves/closes/orders the moment the
 * echo arrives. The per-agent signature diff keeps streaming churn cheap:
 * state updates that do not touch the three sync labels or `archivedAt`
 * never reach the enforcers.
 */
const lastSyncLabelSignature = new Map<string, string>();

function installSessionWatch(): void {
  if (sessionWatchInstalled) {
    return;
  }
  try {
    useSessionStore.subscribe(() => {
      try {
        const sessions = useSessionStore.getState().sessions;
        let changed = false;
        for (const serverId of Object.keys(sessions)) {
          eachSessionAgent(serverId, (agentId, agent) => {
            const key = pendingKey(serverId, agentId);
            const signature = syncLabelSignature(agent.labels, Boolean(agent.archivedAt));
            if (lastSyncLabelSignature.get(key) !== signature) {
              lastSyncLabelSignature.set(key, signature);
              changed = true;
            }
          });
        }
        if (changed) {
          enforceSyncedTabs();
          enforceTabOrder();
        }
      } catch {
        // Best-effort watch.
      }
    });
    sessionWatchInstalled = true;
  } catch {
    // The next sweep retries the install.
  }
}

/**
 * Local layout is the order authority on the focused window: a user drag or a
 * freshly appearing unlabeled tab publishes its labels immediately, debounced
 * and skipped while the enforcer itself is mutating the layout. The local
 * order is marked pending at the layout change, before the delayed write, so a
 * remote label echo that lands in the debounce window cannot restore the old
 * order and swallow the drag. Publishing still runs before converging.
 */
let layoutPublishTimer: ReturnType<typeof setTimeout> | null = null;

function installLayoutWatch(): void {
  if (layoutWatchInstalled) {
    return;
  }
  try {
    activeWorkspaceLayoutStore.subscribe(() => {
      try {
        if (internalSync) {
          return;
        }
        rememberLocalTabOrder();
        if (layoutPublishTimer) {
          clearTimeout(layoutPublishTimer);
        }
        layoutPublishTimer = setTimeout(() => {
          layoutPublishTimer = null;
          try {
            broadcastTabs(true);
            enforceTabOrder();
          } catch {
            // Best-effort publish.
          }
        }, LAYOUT_PUBLISH_DEBOUNCE_MS);
      } catch {
        // Best-effort watch.
      }
    });
    layoutWatchInstalled = true;
  } catch {
    // The next sweep retries the install.
  }
}

/**
 * Install the gesture hooks and event-driven watches, then keep a slow sweep
 * as the backstop for lazily mounted layouts and missed edges. Idempotent.
 */
export function startWorkspaceTabSync(
  options: { layoutStore?: WorkspaceLayoutStoreApi } = {},
): void {
  if (sweepStarted) {
    return;
  }
  activeWorkspaceLayoutStore = options.layoutStore ?? useWorkspaceLayoutStore;
  sweepStarted = true;
  const sweep = () => {
    installStoreHooks();
    installSessionWatch();
    installLayoutWatch();
    enforceSyncedTabs();
    broadcastTabs(false);
    enforceTabOrder();
  };
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS);
}
