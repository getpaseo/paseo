import {
  DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  LOGICAL_WORKSPACE_REF_LABEL_PREFIX,
  parseLogicalWorkspacePlacementLabels,
} from "@getpaseo/protocol/workspace-labels";
import type { ActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import type { PluginSidebarWorkspaceGrouping } from "@/plugins/sidebar-workspace-groupings";
import { aggregateSidebarStateBuckets } from "@/utils/sidebar-agent-state";

export type SidebarLogicalWorkspaceGrouping = PluginSidebarWorkspaceGrouping;

export interface SidebarProjectPhysicalWorkspaceRow {
  kind: "physical";
  key: string;
  placement: SidebarWorkspacePlacement;
}

export interface SidebarProjectLogicalWorkspaceRow {
  kind: "logical";
  key: string;
  groupingKey: string;
  creationServerIds: string[];
  logicalWorkspaceRef: string;
  title: string;
  statusBucket: SidebarWorkspaceEntry["statusBucket"];
  placements: SidebarWorkspacePlacement[];
  retainedAgentSources: SidebarRetainedAgentSource[];
  targetPlacement: SidebarWorkspacePlacement;
  displayEntry: SidebarWorkspaceEntry;
}

export interface SidebarRetainedAgentSource {
  workspaceKey: string;
  serverId: string;
  workspaceId: string;
}

export type SidebarProjectWorkspaceRow =
  | SidebarProjectPhysicalWorkspaceRow
  | SidebarProjectLogicalWorkspaceRow;

export interface SidebarLogicalWorkspaceProjection {
  rowsByProjectViewKey: ReadonlyMap<string, SidebarProjectWorkspaceRow[]>;
  managedWorkspaceKeys: ReadonlySet<string>;
  retainedHistoryWorkspaceKeys: ReadonlySet<string>;
}

interface ManagedPlacement {
  placement: SidebarWorkspacePlacement;
  entry: SidebarWorkspaceEntry;
  defaultPlacement: boolean;
  workspaceKeys: string[];
}

interface RetainedHistoryPlacement {
  placement: SidebarWorkspacePlacement;
  workspaceKeys: string[];
}

interface NativePlacementIdentity {
  placement: SidebarWorkspacePlacement;
  workspaceKeys: string[];
}

interface ClassifiedLogicalGroup {
  grouping: SidebarLogicalWorkspaceGrouping;
  logicalWorkspaceRef: string;
  members: ManagedPlacement[];
}

interface ClassifiedProjectPlacements {
  groups: Map<string, ClassifiedLogicalGroup>;
  groupIdentityByNativeIdentity: Map<string, string>;
  retainedHistoryByGroupIdentity: Map<string, RetainedHistoryPlacement[]>;
  retainedGroupIdentityByNativeIdentity: Map<string, string>;
}

interface RetainedHistoryCandidate {
  grouping: SidebarLogicalWorkspaceGrouping;
  binding: NonNullable<SidebarLogicalWorkspaceGrouping["retainedHistoryBindings"]>[number];
}

interface ProjectRowsResult {
  rows: SidebarProjectWorkspaceRow[];
  managedWorkspaceKeys: Set<string>;
  retainedHistoryWorkspaceKeys: Set<string>;
}

/**
 * Project boundaries come from Paseo's native projectKey projection before this function runs.
 * This layer can replace physical rows only inside one such project; it never reparents or
 * mutates a native workspace identity.
 */
export function buildSidebarLogicalWorkspaceProjection(input: {
  projects: readonly SidebarProjectEntry[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupings: readonly SidebarLogicalWorkspaceGrouping[];
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}): SidebarLogicalWorkspaceProjection {
  const groupings = resolveClosedGroupings(input.groupings);
  const rowsByProjectViewKey = new Map<string, SidebarProjectWorkspaceRow[]>();
  const managedWorkspaceKeys = new Set<string>();
  const retainedHistoryWorkspaceKeys = new Set<string>();

  for (const project of input.projects) {
    const nativeIdentities = deduplicateNativePlacements(project.workspaces);
    if (groupings.length === 0) {
      rowsByProjectViewKey.set(
        project.viewKey,
        nativeIdentities.map((identity) => physicalRow(identity.placement)),
      );
      continue;
    }

    const classified = classifyProjectPlacements({
      nativeIdentities,
      workspaceEntriesByKey: input.workspaceEntriesByKey,
      groupings,
    });
    const result = emitProjectRows({
      projectViewKey: project.viewKey,
      projectServerIds: project.hosts.map((host) => host.serverId),
      groupings,
      nativeIdentities,
      classified,
      activeWorkspaceSelection: input.activeWorkspaceSelection,
    });
    rowsByProjectViewKey.set(project.viewKey, result.rows);
    addWorkspaceKeys(managedWorkspaceKeys, result.managedWorkspaceKeys);
    addWorkspaceKeys(retainedHistoryWorkspaceKeys, result.retainedHistoryWorkspaceKeys);
  }

  return { rowsByProjectViewKey, managedWorkspaceKeys, retainedHistoryWorkspaceKeys };
}

function classifyProjectPlacements(input: {
  nativeIdentities: readonly NativePlacementIdentity[];
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  groupings: readonly SidebarLogicalWorkspaceGrouping[];
}): ClassifiedProjectPlacements {
  const groups = new Map<string, ClassifiedLogicalGroup>();
  const groupIdentityByNativeIdentity = new Map<string, string>();
  const retainedHistoryByGroupIdentity = new Map<string, RetainedHistoryPlacement[]>();
  const retainedGroupIdentityByNativeIdentity = new Map<string, string>();
  const retainedCandidates = indexRetainedHistoryCandidates(input.groupings);

  for (const identity of input.nativeIdentities) {
    const placement = identity.placement;
    const nativeIdentity = nativeWorkspaceIdentity(placement.serverId, placement.workspaceId);
    const retained = retainedCandidates.get(nativeIdentity) ?? [];
    const entry = findWorkspaceEntry(identity, input.workspaceEntriesByKey);
    if (retained.length > 1) continue;
    const retainedCandidate = retained[0];
    if (retainedCandidate && entry) {
      const groupIdentity = logicalGroupIdentity(
        retainedCandidate.grouping.key,
        retainedCandidate.binding.logicalWorkspaceRef,
      );
      const members = retainedHistoryByGroupIdentity.get(groupIdentity) ?? [];
      members.push({ placement, workspaceKeys: identity.workspaceKeys });
      retainedHistoryByGroupIdentity.set(groupIdentity, members);
      retainedGroupIdentityByNativeIdentity.set(nativeIdentity, groupIdentity);
      continue;
    }
    if (!entry) continue;
    const metadata = parseLogicalWorkspacePlacementLabels(entry.labels);
    if (!metadata) continue;
    const matchingGroupings = input.groupings.filter((grouping) =>
      groupingAppliesToServer(grouping, placement.serverId),
    );
    if (matchingGroupings.length !== 1) continue;
    const grouping = matchingGroupings[0];
    if (!grouping) continue;
    const groupIdentity = logicalGroupIdentity(grouping.key, metadata.logicalWorkspaceRef);
    const group = groups.get(groupIdentity) ?? {
      grouping,
      logicalWorkspaceRef: metadata.logicalWorkspaceRef,
      members: [],
    };
    group.members.push({
      placement,
      entry,
      defaultPlacement: metadata.defaultPlacement,
      workspaceKeys: identity.workspaceKeys,
    });
    groups.set(groupIdentity, group);
    groupIdentityByNativeIdentity.set(nativeIdentity, groupIdentity);
  }

  return {
    groups,
    groupIdentityByNativeIdentity,
    retainedHistoryByGroupIdentity,
    retainedGroupIdentityByNativeIdentity,
  };
}

function emitProjectRows(input: {
  projectViewKey: string;
  projectServerIds: readonly string[];
  groupings: readonly SidebarLogicalWorkspaceGrouping[];
  nativeIdentities: readonly NativePlacementIdentity[];
  classified: ClassifiedProjectPlacements;
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}): ProjectRowsResult {
  const emittedGroupIdentities = new Set<string>();
  const rows: SidebarProjectWorkspaceRow[] = [];
  const managedWorkspaceKeys = new Set<string>();
  const retainedHistoryWorkspaceKeys = new Set<string>();

  for (const identity of input.nativeIdentities) {
    const placement = identity.placement;
    const nativeIdentity = nativeWorkspaceIdentity(placement.serverId, placement.workspaceId);
    const retainedGroupIdentity =
      input.classified.retainedGroupIdentityByNativeIdentity.get(nativeIdentity);
    if (retainedGroupIdentity) {
      if (input.classified.groups.has(retainedGroupIdentity)) continue;
      rows.push(physicalRow(placement));
      continue;
    }

    const groupIdentity = input.classified.groupIdentityByNativeIdentity.get(nativeIdentity);
    if (!groupIdentity) {
      rows.push(physicalRow(placement));
      continue;
    }
    if (emittedGroupIdentities.has(groupIdentity)) continue;
    emittedGroupIdentities.add(groupIdentity);

    const group = input.classified.groups.get(groupIdentity);
    if (!group) {
      rows.push(physicalRow(placement));
      continue;
    }
    const retainedHistory =
      input.classified.retainedHistoryByGroupIdentity.get(groupIdentity) ?? [];
    const logicalRow = buildLogicalRow({
      projectViewKey: input.projectViewKey,
      grouping: group.grouping,
      creationServerIds: resolveGroupingCreationServerIds({
        groupingKey: group.grouping.key,
        projectServerIds: input.projectServerIds,
        groupings: input.groupings,
      }),
      logicalWorkspaceRef: group.logicalWorkspaceRef,
      members: group.members,
      retainedHistory,
      activeWorkspaceSelection: input.activeWorkspaceSelection,
    });
    if (!logicalRow) {
      for (const member of group.members) rows.push(physicalRow(member.placement));
      continue;
    }

    rows.push(logicalRow);
    for (const member of group.members) {
      addWorkspaceKeys(managedWorkspaceKeys, member.workspaceKeys);
    }
    for (const retained of retainedHistory) {
      addWorkspaceKeys(managedWorkspaceKeys, retained.workspaceKeys);
      addWorkspaceKeys(retainedHistoryWorkspaceKeys, retained.workspaceKeys);
    }
  }

  return { rows, managedWorkspaceKeys, retainedHistoryWorkspaceKeys };
}

function findWorkspaceEntry(
  identity: NativePlacementIdentity,
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>,
): SidebarWorkspaceEntry | null {
  for (const workspaceKey of identity.workspaceKeys) {
    const entry = workspaceEntriesByKey.get(workspaceKey);
    if (entry) return entry;
  }
  return null;
}

function addWorkspaceKeys(target: Set<string>, keys: Iterable<string>): void {
  for (const key of keys) target.add(key);
}

export function sidebarStatusPlacementsFromRows(
  rows: readonly SidebarProjectWorkspaceRow[],
): SidebarWorkspacePlacement[] {
  return rows.flatMap((row) => (row.kind === "logical" ? row.placements : [row.placement]));
}

function nativeWorkspaceIdentity(serverId: string, workspaceId: string): string {
  return JSON.stringify([serverId, workspaceId]);
}

function deduplicateNativePlacements(
  placements: readonly SidebarWorkspacePlacement[],
): NativePlacementIdentity[] {
  const byIdentity = new Map<string, NativePlacementIdentity>();
  for (const placement of placements) {
    const identity = nativeWorkspaceIdentity(placement.serverId, placement.workspaceId);
    const existing = byIdentity.get(identity);
    if (existing) {
      existing.workspaceKeys.push(placement.workspaceKey);
      continue;
    }
    byIdentity.set(identity, {
      placement,
      workspaceKeys: [placement.workspaceKey],
    });
  }
  return [...byIdentity.values()];
}

function resolveClosedGroupings(
  groupings: readonly SidebarLogicalWorkspaceGrouping[],
): SidebarLogicalWorkspaceGrouping[] {
  const compatible = groupings.filter(
    (grouping) =>
      grouping.logicalWorkspaceRefLabelPrefix === LOGICAL_WORKSPACE_REF_LABEL_PREFIX &&
      grouping.defaultPlacementLabel === DEFAULT_WORKSPACE_PLACEMENT_LABEL,
  );
  const countsByKey = new Map<string, number>();
  for (const grouping of compatible) {
    countsByKey.set(grouping.key, (countsByKey.get(grouping.key) ?? 0) + 1);
  }
  return compatible
    .filter((grouping) => countsByKey.get(grouping.key) === 1)
    .sort((left, right) => left.key.localeCompare(right.key));
}

function indexRetainedHistoryCandidates(
  groupings: readonly SidebarLogicalWorkspaceGrouping[],
): Map<string, RetainedHistoryCandidate[]> {
  const candidatesByIdentity = new Map<string, RetainedHistoryCandidate[]>();
  for (const grouping of groupings) {
    for (const binding of grouping.retainedHistoryBindings ?? []) {
      if (!groupingAppliesToServer(grouping, binding.serverId)) continue;
      const identity = nativeWorkspaceIdentity(binding.serverId, binding.workspaceId);
      const candidates = candidatesByIdentity.get(identity) ?? [];
      candidates.push({ grouping, binding });
      candidatesByIdentity.set(identity, candidates);
    }
  }
  return candidatesByIdentity;
}

function groupingAppliesToServer(
  grouping: SidebarLogicalWorkspaceGrouping,
  serverId: string,
): boolean {
  return !grouping.serverIds || grouping.serverIds.includes(serverId);
}

function resolveGroupingCreationServerIds(input: {
  groupingKey: string;
  projectServerIds: readonly string[];
  groupings: readonly SidebarLogicalWorkspaceGrouping[];
}): string[] {
  return input.projectServerIds.filter((serverId) => {
    const matching = input.groupings.filter((grouping) =>
      groupingAppliesToServer(grouping, serverId),
    );
    return matching.length === 1 && matching[0]?.key === input.groupingKey;
  });
}

function logicalGroupIdentity(groupingKey: string, logicalWorkspaceRef: string): string {
  return JSON.stringify([groupingKey, logicalWorkspaceRef]);
}

function physicalRow(placement: SidebarWorkspacePlacement): SidebarProjectPhysicalWorkspaceRow {
  return { kind: "physical", key: placement.workspaceKey, placement };
}

function buildLogicalRow(input: {
  projectViewKey: string;
  grouping: SidebarLogicalWorkspaceGrouping;
  creationServerIds: string[];
  logicalWorkspaceRef: string;
  members: ManagedPlacement[];
  retainedHistory: RetainedHistoryPlacement[];
  activeWorkspaceSelection: ActiveWorkspaceSelection | null;
}): SidebarProjectLogicalWorkspaceRow | null {
  if (input.members.length === 0) return null;
  const target = selectTarget(input.members, input.activeWorkspaceSelection);
  if (!target) return null;
  const statusBucket = aggregateSidebarStateBuckets(
    input.members.map((member) => member.entry.statusBucket),
  );
  const aggregateStatusEnteredAt =
    input.members
      .filter((member) => member.entry.statusBucket === statusBucket)
      .sort(compareManagedPlacements)[0]?.entry.statusEnteredAt ?? null;
  const title = target.entry.title ?? target.entry.name;
  return {
    kind: "logical",
    key: JSON.stringify([input.grouping.key, input.projectViewKey, input.logicalWorkspaceRef]),
    groupingKey: input.grouping.key,
    creationServerIds: input.creationServerIds,
    logicalWorkspaceRef: input.logicalWorkspaceRef,
    title,
    statusBucket,
    placements: input.members.map((member) => member.placement),
    retainedAgentSources: input.retainedHistory.map(({ placement }) => ({
      workspaceKey: placement.workspaceKey,
      serverId: placement.serverId,
      workspaceId: placement.workspaceId,
    })),
    targetPlacement: target.placement,
    displayEntry: {
      ...target.entry,
      title,
      statusBucket,
      statusEnteredAt: aggregateStatusEnteredAt,
    },
  };
}

function selectTarget(
  members: readonly ManagedPlacement[],
  activeWorkspaceSelection: ActiveWorkspaceSelection | null,
): ManagedPlacement | null {
  const active = members.find(
    (member) =>
      member.placement.serverId === activeWorkspaceSelection?.serverId &&
      member.placement.workspaceId === activeWorkspaceSelection.workspaceId,
  );
  if (active) return active;
  const defaults = members.filter((member) => member.defaultPlacement);
  return [...(defaults.length > 0 ? defaults : members)].sort(compareManagedPlacements)[0] ?? null;
}

function compareManagedPlacements(left: ManagedPlacement, right: ManagedPlacement): number {
  const leftTime = left.entry.statusEnteredAt?.getTime() ?? null;
  const rightTime = right.entry.statusEnteredAt?.getTime() ?? null;
  if (leftTime !== null && rightTime !== null && leftTime !== rightTime) {
    return rightTime - leftTime;
  }
  if (leftTime !== null) return -1;
  if (rightTime !== null) return 1;
  return (
    left.placement.serverId.localeCompare(right.placement.serverId) ||
    left.placement.workspaceId.localeCompare(right.placement.workspaceId)
  );
}
