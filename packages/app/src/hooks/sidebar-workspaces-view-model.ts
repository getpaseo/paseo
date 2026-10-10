import type { PrHint } from "@/git/pr-hint";
import { selectPrHintFromStatus } from "@/git/pr-hint";
import { type HostProjectListItem } from "@/projects/host-project-model";
import type { PendingCreateAttempt } from "@/stores/create-flow-store";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type {
  WorkspaceStructureHostPlacement,
  WorkspaceStructureProject,
} from "@/projects/workspace-structure";
import { projectDisplayNameFromProjectId } from "@/utils/project-display-name";
import { aggregateSidebarStateBuckets } from "@/utils/sidebar-agent-state";
import { shortenPath } from "@/utils/shorten-path";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

const EMPTY_PROJECTS: SidebarProjectEntry[] = [];

export type SidebarStateBucket = WorkspaceDescriptor["status"];

export interface SidebarWorkspacePlacement {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
  projectViewKey: string;
  projectName: string;
  projectRootPath?: string;
  workspaceDirectory?: string;
  projectKind: WorkspaceStructureProject["projectKind"];
  workspaceKind: WorkspaceDescriptor["workspaceKind"];
  background?: boolean;
  name: string;
}

export interface SidebarStatusWorkspacePlacement extends SidebarWorkspacePlacement {
  statusBucket: SidebarStateBucket;
  statusEnteredAt: Date | null;
}

export interface SidebarWorkspaceEntry extends SidebarStatusWorkspacePlacement {
  workspaceDirectory: string;
  workspaceDirectoryLabel: string;
  // Raw user-set title (null when the name is derived from branch/directory).
  // Prefills the rename input and signals whether a reset is available.
  title: string | null;
  pinnedAt?: string | null;
  labels?: string[];
  // Checkout branch (null when not a git checkout or detached HEAD).
  currentBranch: string | null;
  archivingAt: string | null;
  diffStat: { additions: number; deletions: number } | null;
  prHint: PrHint | null;
  archiveHasUncommittedChanges: boolean | null;
  archiveUnpushedCommitCount: number | null;
  scripts: WorkspaceDescriptor["scripts"];
  hasRunningScripts: boolean;
}

export interface SidebarProjectEntry {
  viewKey: string;
  projectName: string;
  projectKind: WorkspaceStructureProject["projectKind"];
  iconWorkingDir: string;
  hosts: WorkspaceStructureHostPlacement[];
  workspaces: SidebarWorkspacePlacement[];
}

export interface SidebarWorkspacePlacementModel {
  workspaces: SidebarWorkspacePlacement[];
  projects: SidebarProjectEntry[];
  projectNamesByViewKey: Map<string, string>;
}

export interface SidebarWorkspaceSession {
  serverId: string;
  workspaces: Map<string, WorkspaceDescriptor>;
  workspaceAgentActivity: Map<string, WorkspaceAgentActivity>;
}

interface SidebarWorkspaceSessionSource {
  workspaces: Map<string, WorkspaceDescriptor>;
  workspaceAgentActivity: Map<string, WorkspaceAgentActivity>;
}

export function selectSidebarWorkspaceSessions(
  sessions: Record<string, SidebarWorkspaceSessionSource | undefined>,
  serverIds: readonly string[],
): SidebarWorkspaceSession[] {
  const selected: SidebarWorkspaceSession[] = [];
  for (const serverId of serverIds) {
    const session = sessions[serverId];
    if (!session) {
      continue;
    }
    selected.push({
      serverId,
      workspaces: session.workspaces,
      workspaceAgentActivity: session.workspaceAgentActivity,
    });
  }
  return selected;
}

export function areSidebarWorkspaceSessionsEqual(
  left: readonly SidebarWorkspaceSession[],
  right: readonly SidebarWorkspaceSession[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const leftSession = left[index];
    const rightSession = right[index];
    if (
      !leftSession ||
      !rightSession ||
      leftSession.serverId !== rightSession.serverId ||
      leftSession.workspaces !== rightSession.workspaces ||
      leftSession.workspaceAgentActivity !== rightSession.workspaceAgentActivity
    ) {
      return false;
    }
  }
  return true;
}

interface EffectiveWorkspaceStatus {
  status: WorkspaceDescriptor["status"];
  enteredAt: Date | null;
}

function projectNameForWorkspace(workspace: WorkspaceDescriptor): string {
  return (
    workspace.projectCustomName ??
    workspace.projectDisplayName ??
    projectDisplayNameFromProjectId(workspace.projectId)
  );
}

function normalizeCurrentBranch(currentBranch: string | null | undefined): string | null {
  if (!currentBranch) {
    return null;
  }
  const trimmed = currentBranch.trim();
  return trimmed.length === 0 || trimmed === "HEAD" ? null : trimmed;
}

export function createSidebarWorkspaceEntry(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  projectViewKey?: string;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  workspaceAgentActivity?: ReadonlyMap<string, WorkspaceAgentActivity>;
}): SidebarWorkspaceEntry {
  const projectViewKey = input.projectViewKey ?? input.workspace.projectId;
  const effectiveStatus = deriveEffectiveWorkspaceStatus(input);
  return {
    workspaceKey: `${input.serverId}:${input.workspace.id}`,
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    projectViewKey,
    projectName: projectNameForWorkspace(input.workspace),
    projectRootPath: input.workspace.projectRootPath,
    workspaceDirectory: input.workspace.workspaceDirectory,
    workspaceDirectoryLabel:
      input.workspace.worktreeSlug ?? shortenPath(input.workspace.workspaceDirectory),
    projectKind: input.workspace.projectKind,
    workspaceKind: input.workspace.workspaceKind,
    background: input.workspace.background,
    name: input.workspace.name,
    title: input.workspace.title ?? null,
    pinnedAt: input.workspace.pinnedAt,
    labels: input.workspace.labels ?? EMPTY_WORKSPACE_LABELS,
    currentBranch: normalizeCurrentBranch(input.workspace.gitRuntime?.currentBranch),
    statusBucket: effectiveStatus.status,
    statusEnteredAt: effectiveStatus.enteredAt,
    archivingAt: input.workspace.archivingAt,
    diffStat: input.workspace.diffStat,
    prHint: selectPrHintFromStatus(
      input.workspace.githubRuntime?.pullRequest,
      input.workspace.forge,
    ),
    archiveHasUncommittedChanges: input.workspace.gitRuntime?.isDirty ?? null,
    archiveUnpushedCommitCount: input.workspace.gitRuntime?.aheadOfOrigin ?? null,
    scripts: input.workspace.scripts,
    hasRunningScripts: input.workspace.scripts.some((script) => script.lifecycle === "running"),
  };
}

const EMPTY_WORKSPACE_LABELS: string[] = [];

function deriveEffectiveWorkspaceStatus(input: {
  serverId: string;
  workspace: WorkspaceDescriptor;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  workspaceAgentActivity?: ReadonlyMap<string, WorkspaceAgentActivity>;
}): EffectiveWorkspaceStatus {
  if (input.workspace.status !== "done") {
    return { status: input.workspace.status, enteredAt: input.workspace.statusEnteredAt };
  }

  const pendingStartedAt = getPendingInitialAgentCreateStartedAt({
    serverId: input.serverId,
    workspaceId: input.workspace.id,
    pendingCreateAttempts: input.pendingCreateAttempts,
  });
  if (pendingStartedAt) {
    return { status: "running", enteredAt: pendingStartedAt };
  }

  const rootAgentActivity = input.workspaceAgentActivity?.get(input.workspace.id);
  if (rootAgentActivity && rootAgentActivity.status !== "done") {
    return rootAgentActivity;
  }

  return { status: input.workspace.status, enteredAt: input.workspace.statusEnteredAt };
}

function getPendingInitialAgentCreateStartedAt(input: {
  serverId: string;
  workspaceId: string;
  pendingCreateAttempts: Record<string, PendingCreateAttempt> | undefined;
}): Date | null {
  let latestStartedAt: Date | null = null;
  for (const pending of Object.values(input.pendingCreateAttempts ?? {})) {
    if (pending.serverId !== input.serverId) continue;
    if (pending.workspaceId !== input.workspaceId) continue;
    if (pending.lifecycle === "abandoned") continue;
    const startedAt = new Date(pending.timestamp);
    if (!latestStartedAt || startedAt > latestStartedAt) {
      latestStartedAt = startedAt;
    }
  }
  return latestStartedAt;
}

export interface ProjectStatusSession {
  workspaces: Map<string, WorkspaceDescriptor>;
  workspaceAgentActivity: Map<string, WorkspaceAgentActivity>;
}

/**
 * Most urgent status among a project's workspaces. Backs the status dot on a collapsed
 * project row, which otherwise hides every workspace-level signal it contains.
 *
 * Workspaces the session hasn't hydrated yet are skipped rather than counted as done —
 * an unknown workspace shouldn't drag the aggregate anywhere. Reuses the same
 * activity-index + effective-status pipeline as per-workspace rows (one pass over the
 * session's agents per server, not per workspace) rather than re-deriving it.
 */
export function deriveProjectStatusBucket(input: {
  workspaces: readonly SidebarWorkspacePlacement[];
  sessions: Record<string, ProjectStatusSession | undefined>;
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
}): SidebarStateBucket {
  const workspaceIdsByServer = new Map<string, string[]>();
  for (const placement of input.workspaces) {
    const existing = workspaceIdsByServer.get(placement.serverId);
    if (existing) {
      existing.push(placement.workspaceId);
    } else {
      workspaceIdsByServer.set(placement.serverId, [placement.workspaceId]);
    }
  }

  const buckets: SidebarStateBucket[] = [];
  for (const [serverId, workspaceIds] of workspaceIdsByServer) {
    const session = input.sessions[serverId];
    if (!session) continue;
    for (const workspaceId of workspaceIds) {
      const workspaceKey = resolveWorkspaceMapKeyByIdentity({
        workspaces: session.workspaces,
        workspaceId,
      });
      const workspace = workspaceKey ? session.workspaces.get(workspaceKey) : undefined;
      if (!workspace) continue;
      buckets.push(
        deriveEffectiveWorkspaceStatus({
          serverId,
          workspace,
          pendingCreateAttempts: input.pendingCreateAttempts,
          workspaceAgentActivity: session.workspaceAgentActivity,
        }).status,
      );
    }
  }

  return aggregateSidebarStateBuckets(buckets);
}

export function buildSidebarWorkspacePlacementModel(input: {
  projects: readonly HostProjectListItem[];
}): SidebarWorkspacePlacementModel {
  const projects = buildSidebarProjectsFromHostProjects({ projects: input.projects });
  return {
    projects,
    workspaces: projects.flatMap((project) => project.workspaces),
    projectNamesByViewKey: new Map(
      projects.map((project) => [project.viewKey, project.projectName]),
    ),
  };
}

function createStructuralWorkspaceEntry(input: {
  project: HostProjectListItem;
  workspaceKey: string;
}): SidebarWorkspacePlacement {
  const identity = resolveStructuralWorkspaceIdentity({
    project: input.project,
    workspaceKey: input.workspaceKey,
  });

  return {
    workspaceKey: identity.workspaceKey,
    serverId: identity.serverId,
    workspaceId: identity.workspaceId,
    projectViewKey: input.project.viewKey,
    projectName: input.project.projectName,
    projectRootPath: input.project.iconWorkingDir,
    workspaceDirectory: undefined,
    projectKind: input.project.projectKind,
    workspaceKind: "checkout",
    name: identity.workspaceId,
  };
}

function resolveStructuralWorkspaceIdentity(input: {
  project: HostProjectListItem;
  workspaceKey: string;
}): {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
} {
  const hostsByLongestPrefix = [...input.project.hosts].sort(
    (left, right) => right.serverId.length - left.serverId.length,
  );

  for (const host of hostsByLongestPrefix) {
    const prefix = `${host.serverId}:`;
    if (!input.workspaceKey.startsWith(prefix)) continue;
    const workspaceId = input.workspaceKey.slice(prefix.length);
    if (!workspaceId) continue;
    return {
      workspaceKey: input.workspaceKey,
      serverId: host.serverId,
      workspaceId,
    };
  }

  const separatorIndex = input.workspaceKey.indexOf(":");
  if (separatorIndex > 0) {
    return {
      workspaceKey: input.workspaceKey,
      serverId: input.workspaceKey.slice(0, separatorIndex),
      workspaceId: input.workspaceKey.slice(separatorIndex + 1),
    };
  }

  const serverId = input.project.hosts[0]?.serverId ?? input.workspaceKey;
  return {
    workspaceKey: `${serverId}:${input.workspaceKey}`,
    serverId,
    workspaceId: input.workspaceKey,
  };
}

export function buildSidebarWorkspaceEntries(input: {
  placements: readonly SidebarWorkspacePlacement[];
  sessions: SidebarWorkspaceSession[];
  pendingCreateAttempts?: Record<string, PendingCreateAttempt>;
  previousEntries?: ReadonlyMap<string, SidebarWorkspaceEntry>;
}): Map<string, SidebarWorkspaceEntry> {
  if (input.placements.length === 0 || input.sessions.length === 0) {
    return new Map();
  }

  const sessionByServerId = new Map(input.sessions.map((session) => [session.serverId, session]));
  const entries = new Map<string, SidebarWorkspaceEntry>();

  for (const placement of input.placements) {
    const session = sessionByServerId.get(placement.serverId);
    if (!session) continue;
    const workspaceKey = resolveWorkspaceMapKeyByIdentity({
      workspaces: session.workspaces,
      workspaceId: placement.workspaceId,
    });
    const workspace = workspaceKey ? session.workspaces.get(workspaceKey) : null;
    if (!workspace) continue;

    const entry = createSidebarWorkspaceEntry({
      serverId: placement.serverId,
      workspace,
      projectViewKey: placement.projectViewKey,
      pendingCreateAttempts: input.pendingCreateAttempts,
      workspaceAgentActivity: session.workspaceAgentActivity,
    });
    const previousEntry = input.previousEntries?.get(placement.workspaceKey);
    entries.set(
      placement.workspaceKey,
      previousEntry && areSidebarWorkspaceEntriesEqual(previousEntry, entry)
        ? previousEntry
        : entry,
    );
  }

  return entries;
}

function areSidebarWorkspaceEntriesEqual(
  left: SidebarWorkspaceEntry,
  right: SidebarWorkspaceEntry,
): boolean {
  const keys = Object.keys(left) as Array<keyof SidebarWorkspaceEntry>;
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => {
    if (key !== "prHint") return Object.is(left[key], right[key]);
    const leftHint = left.prHint;
    const rightHint = right.prHint;
    return (
      leftHint === rightHint ||
      (leftHint !== null &&
        rightHint !== null &&
        leftHint.url === rightHint.url &&
        leftHint.number === rightHint.number &&
        leftHint.state === rightHint.state &&
        leftHint.checks === rightHint.checks &&
        leftHint.checksStatus === rightHint.checksStatus &&
        leftHint.reviewDecision === rightHint.reviewDecision)
    );
  });
}

export function buildSidebarProjectsFromStructure(input: {
  projects: WorkspaceStructureProject[];
}): SidebarProjectEntry[] {
  return buildSidebarProjectsFromHostProjects({
    projects: input.projects.map((project) => ({
      viewKey: project.viewKey,
      projectKey: project.projectKey,
      projectName: project.projectName,
      projectKind: project.projectKind,
      iconWorkingDir: project.iconWorkingDir,
      hosts: project.hosts,
      workspaceKeys: project.workspaceKeys,
    })),
  });
}

export function buildSidebarProjectsFromHostProjects(input: {
  projects: readonly HostProjectListItem[];
}): SidebarProjectEntry[] {
  if (input.projects.length === 0) {
    return EMPTY_PROJECTS;
  }

  return input.projects.map((project) => ({
    viewKey: project.viewKey,
    projectName: project.projectName,
    projectKind: project.projectKind,
    iconWorkingDir: project.iconWorkingDir,
    hosts: project.hosts,
    workspaces: project.workspaceKeys.map((workspaceKey) =>
      createStructuralWorkspaceEntry({
        project,
        workspaceKey,
      }),
    ),
  }));
}

// Host labels disambiguate which machine a workspace lives on; they only earn their
// space once the visible sidebar spans more than one host. Counting distinct hosts
// across the visible projects (not all connected hosts) keeps labels off when a host
// filter pins the view to a single host.
export function shouldShowSidebarHostLabels(projects: SidebarProjectEntry[]): boolean {
  const serverIds = new Set<string>();
  for (const project of projects) {
    for (const host of project.hosts) {
      serverIds.add(host.serverId);
    }
  }
  return serverIds.size >= 2;
}

export function applyStoredOrdering<T>(input: {
  items: T[];
  storedOrder: string[];
  getKey: (item: T) => string;
}): T[] {
  if (input.items.length <= 1 || input.storedOrder.length === 0) {
    return input.items;
  }

  const itemByKey = new Map<string, T>();
  for (const item of input.items) {
    itemByKey.set(input.getKey(item), item);
  }

  const prunedOrder: string[] = [];
  const seen = new Set<string>();
  for (const key of input.storedOrder) {
    if (!itemByKey.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    prunedOrder.push(key);
  }

  if (prunedOrder.length === 0) {
    return input.items;
  }

  const orderedSet = new Set(prunedOrder);
  const ordered: T[] = [];
  let orderedIndex = 0;

  for (const item of input.items) {
    const key = input.getKey(item);
    if (!orderedSet.has(key)) {
      ordered.push(item);
      continue;
    }

    const targetKey = prunedOrder[orderedIndex] ?? key;
    orderedIndex += 1;
    ordered.push(itemByKey.get(targetKey) ?? item);
  }

  return ordered;
}

export function appendMissingOrderKeys(input: {
  currentOrder: string[];
  visibleKeys: string[];
}): string[] {
  if (input.visibleKeys.length === 0) {
    return input.currentOrder;
  }

  const existingKeys = new Set(input.currentOrder);
  const missingKeys = input.visibleKeys.filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return input.currentOrder;
  }

  return [...input.currentOrder, ...missingKeys];
}

export function prependMissingOrderKeys(input: {
  currentOrder: string[];
  visibleKeys: string[];
}): string[] {
  if (input.visibleKeys.length === 0) {
    return input.currentOrder;
  }

  const existingKeys = new Set(input.currentOrder);
  const missingKeys = input.visibleKeys.filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return input.currentOrder;
  }

  return [...missingKeys, ...input.currentOrder];
}

export interface SidebarOrderUpdates {
  projectOrder: string[] | null;
  workspaceOrders: Array<{ projectViewKey: string; order: string[] }>;
}

export function computeSidebarOrderUpdates(input: {
  projects: SidebarProjectEntry[];
  persistedProjectOrder: string[];
  getWorkspaceOrder: (projectViewKey: string) => string[];
}): SidebarOrderUpdates {
  if (input.projects.length === 0) {
    return { projectOrder: null, workspaceOrders: [] };
  }

  const nextProjectOrder = appendMissingOrderKeys({
    currentOrder: input.persistedProjectOrder,
    visibleKeys: input.projects.map((project) => project.viewKey),
  });
  const projectOrder = nextProjectOrder === input.persistedProjectOrder ? null : nextProjectOrder;

  const workspaceOrders: Array<{ projectViewKey: string; order: string[] }> = [];
  for (const project of input.projects) {
    const persistedWorkspaceOrder = input.getWorkspaceOrder(project.viewKey);
    const nextWorkspaceOrder = prependMissingOrderKeys({
      currentOrder: persistedWorkspaceOrder,
      visibleKeys: project.workspaces.map((workspace) => workspace.workspaceKey),
    });
    if (nextWorkspaceOrder !== persistedWorkspaceOrder) {
      workspaceOrders.push({ projectViewKey: project.viewKey, order: nextWorkspaceOrder });
    }
  }

  return { projectOrder, workspaceOrders };
}

export interface SidebarLoadingState {
  isLoading: boolean;
  isInitialLoad: boolean;
  isRevalidating: boolean;
}

export function deriveSidebarLoadingState(input: {
  isActive: boolean;
  serverIds: string[];
  hydratedServerIds: string[];
  hasProjects: boolean;
}): SidebarLoadingState {
  const hasRegisteredHosts = input.serverIds.length > 0;
  const allHydrated =
    input.serverIds.length > 0 && input.serverIds.length === input.hydratedServerIds.length;
  const isLoading = input.isActive && hasRegisteredHosts && !allHydrated;
  const isInitialLoad = isLoading && !input.hasProjects;
  return { isLoading, isInitialLoad, isRevalidating: false };
}

/**
 * The persisted sidebar order, as stored.
 */
export interface SidebarOrderState {
  projectOrder: string[];
  pinnedWorkspaceOrder: string[];
  workspaceOrderByProject: Record<string, string[]>;
}

/**
 * What this device can currently see. Only a server listed in `servers` may judge a key,
 * and `hostIds` must carry EVERY registered host id — not just the visible ones — because
 * a workspace key has to be attributed to its owning server before anyone may claim it is
 * gone (see `resolveStructuralWorkspaceIdentity` for the same longest-prefix-first rule).
 */
export interface SidebarOrderLiveState {
  /** Registered host ids, any order; consumed longest-first. */
  hostIds: readonly string[];
  /** Servers whose workspace list was received in full, mapped to the keys it reported. */
  servers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Project view keys the sidebar can currently see. */
  visibleProjects: ReadonlySet<string>;
}

const SIDEBAR_PLACEMENT_HISTORY_KEY = "@airlock:sidebar-placement-keys:v1";

/**
 * Removes workspace keys that a server which reported its full workspace list no longer
 * has, the project records that emptying leaves behind, and the project-order entries of
 * projects that are no longer visible.
 *
 * The reconcile above only ever adds: `prependMissingOrderKeys` and
 * `appendMissingOrderKeys` prepend or append, so a key whose workspace was archived, whose
 * project was deleted, or whose host is gone stays in the stored order forever. On a
 * device that syncs the order this is not merely untidy — the stored order is the shared
 * one, it grows once per workspace the box has ever had, and it eventually stops being
 * writable at all. Removing it at the point the order is written keeps the shared value
 * proportional to what exists now.
 *
 * Deliberately narrow. Nothing is removed unless a server that reported its whole
 * workspace list is the one that owns the key, so a device that has not received the
 * directory, or a host the sidebar filter hides, cannot delete an order somebody else
 * still has. Returns the SAME state object when there is nothing to remove, which lets
 * the caller skip the write entirely.
 */
export function pruneSidebarOrder(
  state: SidebarOrderState,
  live: SidebarOrderLiveState,
): SidebarOrderState {
  const servers = live.servers;
  if (!servers || servers.size === 0 || live.hostIds.length === 0) return state;

  const visibleProjects = live.visibleProjects ?? new Set<string>();
  // Longest first, matching `resolveStructuralWorkspaceIdentity`: the first host whose
  // prefix matches owns the key, whether or not that host is allowed to judge it.
  const hostIds = [...live.hostIds].sort((left, right) => right.length - left.length);

  const isStale = (key: string): boolean => {
    if (typeof key !== "string" || key.length === 0) return false;
    for (const hostId of hostIds) {
      if (!key.startsWith(`${hostId}:`)) continue;
      const known = servers.get(hostId);
      // A server with no list is skipped rather than read as "it has nothing" — guessing
      // there is how a live key gets deleted.
      return known !== undefined && !known.has(key);
    }
    return false;
  };

  const keepLive = (order: readonly string[]): string[] => {
    const next = order.filter((key) => !isStale(key));
    return next.length === order.length ? (order as string[]) : next;
  };

  const workspaceOrderByProject: Record<string, string[]> = {};
  const emptied = new Set<string>();
  let ordersChanged = false;
  for (const [projectViewKey, order] of Object.entries(state.workspaceOrderByProject)) {
    // The placement history is a fixed-size log of identity transitions rather than a
    // workspace list, so it is never a candidate.
    let next =
      projectViewKey === SIDEBAR_PLACEMENT_HISTORY_KEY ||
      !Array.isArray(order) ||
      order.length === 0
        ? order
        : keepLive(order);
    // A record this pass would EMPTY while its project is still on screen is left as it
    // was. Its stale keys still name the complete server that owns them, so a later pass
    // removes them and the projectOrder slot in the SAME step; an empty array names no
    // server and would leave nothing to act on. A record that was ALREADY empty is not
    // evidence of anything and is never touched either way.
    if (next !== order && next.length === 0 && visibleProjects.has(projectViewKey)) {
      next = order;
    }
    workspaceOrderByProject[projectViewKey] = next;
    if (next !== order) {
      ordersChanged = true;
      if (next.length === 0) emptied.add(projectViewKey);
    }
  }

  const pinnedWorkspaceOrder = keepLive(state.pinnedWorkspaceOrder);
  // A project whose order was removed, and that this device can no longer see, is gone. A
  // VISIBLE one keeps both its slot and its record: dropping it would let the next
  // reconcile append it straight back and this remove it again. A projectOrder key with
  // NO record at all is a project this device has no evidence about, and is left alone.
  const projectOrder = state.projectOrder.filter((key) => !emptied.has(key));

  if (
    !ordersChanged &&
    pinnedWorkspaceOrder === state.pinnedWorkspaceOrder &&
    projectOrder.length === state.projectOrder.length
  ) {
    return state;
  }

  for (const projectViewKey of emptied) delete workspaceOrderByProject[projectViewKey];
  return { projectOrder, pinnedWorkspaceOrder, workspaceOrderByProject };
}

/**
 * Splits the sidebar's current view into what `pruneSidebarOrder` needs: every
 * workspace key each host that reported a complete list still has.
 *
 * Kept separate from the prune so the live state can be assembled — and tested — without
 * a store, and so the "only a complete list may judge a key" rule has exactly one home.
 */
export function buildSidebarOrderLiveState(input: {
  projects: readonly SidebarProjectEntry[];
  registeredHostIds: readonly string[];
  completeWorkspaceListServerIds: readonly string[];
}): SidebarOrderLiveState {
  const complete = new Set(input.completeWorkspaceListServerIds);
  const visibleProjects = new Set<string>();
  const servers = new Map<string, Set<string>>();
  // Longest first, matching `resolveStructuralWorkspaceIdentity`: the first host whose
  // prefix matches owns the key. Sorted ONCE, over every registered id, because a host
  // the sidebar filter hides still owns its workspaces.
  const owners = [...new Set(input.registeredHostIds)].sort(
    (left, right) => right.length - left.length,
  );

  for (const project of input.projects) {
    visibleProjects.add(project.viewKey);
    for (const workspace of project.workspaces) {
      const owner = owners.find((hostId) => workspace.workspaceKey.startsWith(`${hostId}:`));
      // Only a host that reported a complete list may judge its keys. An unlisted owner is
      // left alone: the key belongs to a server this device has no evidence about.
      if (owner === undefined || !complete.has(owner)) continue;
      let keys = servers.get(owner);
      if (!keys) {
        keys = new Set<string>();
        servers.set(owner, keys);
      }
      keys.add(workspace.workspaceKey);
    }
  }

  return { hostIds: owners, servers, visibleProjects };
}
