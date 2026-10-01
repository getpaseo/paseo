import type { PrHint } from "@/git/pr-hint";
import { selectRelatedPullRequests, type RelatedPullRequest } from "@/git/related-pull-requests";
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
import {
  collectAllPanes,
  collectAllTabs,
  type WorkspaceLayout,
} from "@/stores/workspace-layout-actions";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import type { DraftRecord } from "@/stores/draft-store/state";

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
  name: string;
}

export interface SidebarStatusWorkspacePlacement extends SidebarWorkspacePlacement {
  statusBucket: SidebarStateBucket;
  statusEnteredAt: Date | null;
}

export interface SidebarWorkspaceEntry extends SidebarStatusWorkspacePlacement {
  workspaceDirectory: string;
  workspaceDirectoryLabel: string;
  title: string | null;
  pinnedAt?: string | null;
  labels?: string[];
  currentBranch: string | null;
  archivingAt: string | null;
  diffStat: { additions: number; deletions: number } | null;
  prHint: PrHint | null;
  relatedPullRequests?: readonly RelatedPullRequest[];
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
  hasHydratedAgents?: boolean;
  workspaces: Map<string, WorkspaceDescriptor>;
  workspaceAgentActivity: Map<string, WorkspaceAgentActivity>;
}

interface SidebarWorkspaceSessionSource {
  hasHydratedAgents?: boolean;
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
      hasHydratedAgents: session.hasHydratedAgents,
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
      leftSession.hasHydratedAgents !== rightSession.hasHydratedAgents ||
      leftSession.workspaces !== rightSession.workspaces ||
      leftSession.workspaceAgentActivity !== rightSession.workspaceAgentActivity
    ) {
      return false;
    }
  }
  return true;
}

export function filterEmptySidebarWorkspaces(input: {
  model: SidebarWorkspacePlacementModel;
  hasHydratedLayouts: boolean;
  hasHydratedDrafts: boolean;
  sessions: readonly SidebarWorkspaceSession[];
  layouts: Readonly<Record<string, WorkspaceLayout>>;
  drafts: Readonly<Record<string, DraftRecord>>;
  pendingCreateAttempts: Readonly<Record<string, PendingCreateAttempt>>;
}): SidebarWorkspacePlacementModel {
  if (!input.hasHydratedLayouts || !input.hasHydratedDrafts) return input.model;
  const sessions = new Map(input.sessions.map((session) => [session.serverId, session]));
  const creating = new Set(
    Object.values(input.pendingCreateAttempts)
      .filter((attempt) => attempt.lifecycle === "active" && attempt.workspaceId)
      .map((attempt) => `${attempt.serverId}:${attempt.workspaceId}`),
  );
  const workspaces = input.model.workspaces.filter((placement) => {
    const session = sessions.get(placement.serverId);
    if (!session?.hasHydratedAgents) return true;
    if (session.workspaceAgentActivity.has(placement.workspaceId)) return true;
    if (creating.has(placement.workspaceKey)) return true;
    const workspace = session.workspaces.get(placement.workspaceId);
    if (workspace?.scripts.some((script) => script.lifecycle === "running")) return true;
    const layout = input.layouts[placement.workspaceKey];
    if (!layout) return false;
    const visibleTabIds = new Set(collectAllPanes(layout.root).flatMap((pane) => pane.tabIds));
    return collectAllTabs(layout.root).some(({ tabId, target }) => {
      if (!visibleTabIds.has(tabId) && (target.kind === "files" || target.kind === "changes_tree"))
        return false;
      if (target.kind === "new_tab") return false;
      if (target.kind !== "draft") return true;
      const draft =
        input.drafts[
          buildDraftStoreKey({
            serverId: placement.serverId,
            agentId: "",
            draftId: target.draftId,
          })
        ];
      return (
        draft?.lifecycle === "active" &&
        (draft.input.text.trim().length > 0 || draft.input.attachments.length > 0)
      );
    });
  });
  if (workspaces.length === input.model.workspaces.length) return input.model;
  const visibleKeys = new Set(workspaces.map((workspace) => workspace.workspaceKey));
  return {
    ...input.model,
    workspaces,
    projects: input.model.projects.map((project) => {
      const visible = project.workspaces.filter((workspace) =>
        visibleKeys.has(workspace.workspaceKey),
      );
      return visible.length === project.workspaces.length
        ? project
        : { ...project, workspaces: visible };
    }),
  };
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
  sharesDirectory?: boolean;
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
    name: input.workspace.name,
    title: input.workspace.title ?? null,
    pinnedAt: input.workspace.pinnedAt,
    labels: input.workspace.labels ?? EMPTY_WORKSPACE_LABELS,
    currentBranch: normalizeCurrentBranch(input.workspace.gitRuntime?.currentBranch),
    statusBucket: effectiveStatus.status,
    statusEnteredAt: effectiveStatus.enteredAt,
    archivingAt: input.workspace.archivingAt,
    diffStat: input.sharesDirectory ? null : input.workspace.diffStat,
    prHint: selectPrHintFromStatus(
      input.workspace.githubRuntime?.pullRequest,
      input.workspace.forge,
    ),
    relatedPullRequests: selectRelatedPullRequests(input.workspace.githubRuntime),
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
  const directoryCounts = new Map<string, number>();
  for (const session of input.sessions) {
    for (const workspace of session.workspaces.values()) {
      if (!workspace.workspaceDirectory) continue;
      const key = `${session.serverId}:${workspace.workspaceDirectory}`;
      directoryCounts.set(key, (directoryCounts.get(key) ?? 0) + 1);
    }
  }

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
      sharesDirectory:
        (directoryCounts.get(`${placement.serverId}:${workspace.workspaceDirectory}`) ?? 0) > 1,
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
