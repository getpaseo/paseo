import { useMemo } from "react";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useProviderSubagentStore } from "@/subagents/provider-store";
import {
  indexDisclosureChildren,
  moreUrgentDisclosureNotice,
  noticeForIndexedChild,
  noticeForIndexedChildren,
  providerDisclosureNotice,
  type DisclosureNoticeAgent,
  type IndexedDisclosureChild,
  type SubagentDisclosureNotice,
} from "./subagent-notice";
import { selectWorkspaceStatusBuckets } from "./sort-clocks";

type SessionState = ReturnType<typeof useSessionStore.getState>;
type ProviderState = ReturnType<typeof useProviderSubagentStore.getState>;

const EMPTY_CHILDREN: ReadonlyMap<string, readonly IndexedDisclosureChild[]> = new Map();

let agentSources: Array<[string, ReadonlyMap<string, Agent>]> = [];
let indexedChildren: ReadonlyMap<string, readonly IndexedDisclosureChild[]> = EMPTY_CHILDREN;

/**
 * Built once per agent-map change and reused by every workspace row. The fold for one row's
 * tabs is then a walk of those parents' children.
 */
function selectIndexedDisclosureChildren(
  state: SessionState,
): ReadonlyMap<string, readonly IndexedDisclosureChild[]> {
  const sources = Object.entries(state.sessions).map(
    ([serverId, session]) => [serverId, session.agents] as [string, ReadonlyMap<string, Agent>],
  );
  if (
    sources.length === agentSources.length &&
    sources.every(
      ([serverId, agents], index) =>
        agentSources[index]?.[0] === serverId && agentSources[index]?.[1] === agents,
    )
  ) {
    return indexedChildren;
  }
  agentSources = sources;
  const byServer: Array<[string, DisclosureNoticeAgent[]]> = [];
  for (const [serverId, agents] of sources) {
    const list: DisclosureNoticeAgent[] = [];
    for (const agent of agents.values()) list.push(toDisclosureNoticeAgent(agent));
    byServer.push([serverId, list]);
  }
  indexedChildren = byServer.length === 0 ? EMPTY_CHILDREN : indexDisclosureChildren(byServer);
  return indexedChildren;
}

function toDisclosureNoticeAgent(agent: Agent): DisclosureNoticeAgent {
  return {
    id: agent.id,
    serverId: agent.serverId,
    workspaceId: agent.workspaceId,
    archivedAt: agent.archivedAt,
    background: agent.background,
    labels: agent.labels,
    status: agent.status,
    turnOpen: agent.turn.phase === "open",
    pendingPermissionCount: agent.pendingPermissions.length,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
  };
}

export function useSubagentDisclosureNotice(
  serverId: string,
  workspaceId: string,
  parentAgentIds: readonly string[],
): SubagentDisclosureNotice | null {
  const paseo = usePaseoDisclosureNotice(serverId, workspaceId, parentAgentIds);
  const provider = useProviderDisclosureNotice(serverId, parentAgentIds);
  return moreUrgentDisclosureNotice(paseo, provider);
}

function usePaseoDisclosureNotice(
  serverId: string,
  workspaceId: string,
  parentAgentIds: readonly string[],
): SubagentDisclosureNotice | null {
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const parentKey = parentAgentIds.join("\0");
  const selectNotice = useMemo(() => {
    let lastChildren: ReadonlyMap<string, readonly IndexedDisclosureChild[]> | null = null;
    let lastStatuses: ReadonlyMap<string, SidebarStateBucket> | null = null;
    let lastNotice: SubagentDisclosureNotice | null = null;
    return (state: SessionState): SubagentDisclosureNotice | null => {
      if (!parentKey) return null;
      const children = selectIndexedDisclosureChildren(state);
      const statuses = selectWorkspaceStatusBuckets(state);
      if (children === lastChildren && statuses === lastStatuses) return lastNotice;
      lastChildren = children;
      lastStatuses = statuses;
      lastNotice = noticeForIndexedChildren({
        listingServerId: serverId,
        listingWorkspaceId: workspaceId,
        parentAgentIds,
        childrenByParent: children,
        pendingArchiveIds,
        workspaceStatus: (statusServerId, statusWorkspaceId) =>
          statuses.get(`${statusServerId}:${statusWorkspaceId}`) ?? null,
      });
      return lastNotice;
    };
  }, [parentAgentIds, parentKey, pendingArchiveIds, serverId, workspaceId]);
  return useSessionStore(selectNotice);
}

function useProviderDisclosureNotice(
  serverId: string,
  parentAgentIds: readonly string[],
): SubagentDisclosureNotice | null {
  const parentKey = parentAgentIds.join("\0");
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const selectNotice = useMemo(() => {
    let descriptors: ProviderState["descriptors"] | null = null;
    let hidden: ProviderState["hiddenFromTrack"] | null = null;
    let notice: SubagentDisclosureNotice | null = null;
    return (state: ProviderState): SubagentDisclosureNotice | null => {
      if (!parentKey) return null;
      if (state.descriptors === descriptors && state.hiddenFromTrack === hidden) return notice;
      descriptors = state.descriptors;
      hidden = state.hiddenFromTrack;
      notice = providerDisclosureNotice({
        serverId,
        parentAgentIds: new Set(parentAgentIds),
        descriptors: state.descriptors,
        hiddenFromTrack: state.hiddenFromTrack,
        nestingSupported,
      });
      return notice;
    };
  }, [nestingSupported, parentAgentIds, parentKey, serverId]);
  return useProviderSubagentStore(selectNotice);
}

interface SubagentRowNoticeInput {
  /** The workspace whose list shows the row. */
  serverId: string;
  workspaceId: string;
  parentAgentId: string;
  /** The subagent's own address, which can be on another host than the list. */
  childServerId: string;
  childId: string;
}

/**
 * One Paseo subagent's notice, for its row: the same rule the disclosure folds over all of them,
 * so the row the dot points at is the row that carries it. Reads the shared child index, and
 * returns a primitive, so a row re-renders only when its own notice changes.
 */
export function useSubagentRowNotice(
  input: SubagentRowNoticeInput,
): SubagentDisclosureNotice | null {
  const { serverId, workspaceId, parentAgentId, childServerId, childId } = input;
  const selectNotice = useMemo(() => {
    let lastChildren: ReadonlyMap<string, readonly IndexedDisclosureChild[]> | null = null;
    let lastStatuses: ReadonlyMap<string, SidebarStateBucket> | null = null;
    let lastNotice: SubagentDisclosureNotice | null = null;
    return (state: SessionState): SubagentDisclosureNotice | null => {
      const children = selectIndexedDisclosureChildren(state);
      const statuses = selectWorkspaceStatusBuckets(state);
      if (children === lastChildren && statuses === lastStatuses) return lastNotice;
      lastChildren = children;
      lastStatuses = statuses;
      const child = children
        .get(`${serverId}:${parentAgentId}`)
        ?.find((candidate) => candidate.id === childId && candidate.serverId === childServerId);
      lastNotice = child
        ? noticeForIndexedChild(child, {
            listingServerId: serverId,
            listingWorkspaceId: workspaceId,
            workspaceStatus: (statusServerId, statusWorkspaceId) =>
              statuses.get(`${statusServerId}:${statusWorkspaceId}`) ?? null,
          })
        : null;
      return lastNotice;
    };
  }, [childId, childServerId, parentAgentId, serverId, workspaceId]);
  return useSessionStore(selectNotice);
}
