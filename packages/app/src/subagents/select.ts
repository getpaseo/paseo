import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { useEffect, useMemo } from "react";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useShallow } from "zustand/react/shallow";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import {
  getSubagentActivity,
  managedActivityKey,
  managedSubtreeAddresses,
  providerSubagentKey,
  providerRunningDescendants,
  sameActivitySessions,
  type SubagentActivity,
  type SubagentActivitySessions,
} from "./activity";
import equal from "fast-deep-equal";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { hydrateProviderSubagents, useProviderSubagentStore } from "./provider-store";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";

export interface PaseoSubagentRow {
  kind: "paseo";
  address: AgentAddress;
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  /** Managed agents have a real title, so the union's task line is always absent for them. */
  description: null;
  subtitle: null;
  status: Agent["status"];
  turn: Agent["turn"];
  hasActiveDescendants: boolean;
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
}

export interface ProviderSubagentRow {
  kind: "provider";
  id: string;
  parentAgentId: string;
  provider: ProviderSubagentDescriptorPayload["provider"];
  // `title` is the subagent type ("Explore", "general-purpose") and repeats across a fan-out;
  // `description` is the task it was given. Both are carried so presentation can choose which
  // one names the row — collapsing them here is what makes every row read alike.
  title: string | null;
  description: string | null;
  /** Compact provider-owned context. The app displays it without interpreting its contents. */
  subtitle: string | null;
  status: ProviderSubagentDescriptorPayload["status"];
  hasActiveDescendants: boolean;
  requiresAttention: boolean;
  createdAt: Date;
}

export type SubagentRow = PaseoSubagentRow | ProviderSubagentRow;

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;
type ProviderSubagentStoreSnapshot = ReturnType<typeof useProviderSubagentStore.getState>;

interface SelectSubagentsParams {
  serverId: string;
  parentAgentId: string;
  /** Select children of this provider subagent instead of children of the managed agent. */
  providerParentSubagentId?: string;
}

const EMPTY_DESCRIPTORS = new Map<string, ProviderSubagentDescriptorPayload>();
const EMPTY_IDS = new Set<string>();

const EMPTY_SUBAGENT_ROWS: SubagentRow[] = [];
const EMPTY_PROVIDER_SUBAGENT_ROWS: ProviderSubagentRow[] = [];

function toSubagentRow(agent: Agent, activity: SubagentActivity): SubagentRow {
  return {
    kind: "paseo",
    address: { serverId: agent.serverId, agentId: agent.id },
    id: agent.id,
    provider: agent.provider,
    title: agent.title,
    description: null,
    subtitle: null,
    status: agent.status,
    turn: agent.turn,
    hasActiveDescendants: activity.managed.has(
      managedActivityKey({ serverId: agent.serverId, agentId: agent.id }),
    ),
    requiresAttention: agent.requiresAttention,
    createdAt: agent.createdAt,
  };
}

export function selectSubagentsForParent(
  state: SessionStoreSnapshot,
  params: SelectSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
  activity = getSubagentActivity({
    sessions: state.sessions,
    descriptors: EMPTY_DESCRIPTORS,
    hiddenFromTrack: EMPTY_IDS,
    pendingArchiveKeys: pendingArchiveIds,
  }),
): SubagentRow[] {
  const rows: SubagentRow[] = [];
  for (const [serverId, session] of Object.entries(state.sessions)) {
    for (const agent of session.agents.values()) {
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      if (
        agent.archivedAt ||
        pendingArchiveIds.has(`${serverId}:${agent.id}`) ||
        parent?.serverId !== params.serverId ||
        parent.agentId !== params.parentAgentId
      )
        continue;
      rows.push(toSubagentRow(agent, activity));
    }
  }

  if (rows.length === 0) {
    return EMPTY_SUBAGENT_ROWS;
  }

  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

// Session-store selectors run on every store update, including every stream tick, which
// leaves the agent map untouched. Reuse the previous rows until the map changes, and keep
// them when a recompute yields equal rows so the hook's equality check stays O(1).
export function createSubagentsForParentSelector(
  params: SelectSubagentsParams,
  pendingArchiveIds: ReadonlySet<string>,
  activity?: SubagentActivity,
): (state: SessionStoreSnapshot) => SubagentRow[] {
  let previousAgents: Array<[string, Map<string, Agent>]> = [];
  let previousRows: SubagentRow[] | null = null;

  return (state) => {
    const agents = Object.entries(state.sessions).map(
      ([serverId, session]) => [serverId, session.agents] as [string, Map<string, Agent>],
    );
    if (
      previousRows &&
      agents.length === previousAgents.length &&
      agents.every(
        ([serverId, map], index) =>
          previousAgents[index]?.[0] === serverId && previousAgents[index]?.[1] === map,
      )
    ) {
      return previousRows;
    }

    const rows = selectSubagentsForParent(state, params, pendingArchiveIds, activity);
    previousAgents = agents;
    if (!previousRows || !equal(previousRows, rows)) {
      previousRows = rows;
    }
    return previousRows;
  };
}

export function selectProviderSubagentsForParent(
  state: ProviderSubagentStoreSnapshot,
  params: SelectSubagentsParams,
  supported: boolean,
  nestingSupported = false,
  activity?: SubagentActivity,
): ProviderSubagentRow[] {
  if (!supported) return EMPTY_PROVIDER_SUBAGENT_ROWS;
  if (params.providerParentSubagentId && !nestingSupported) return EMPTY_PROVIDER_SUBAGENT_ROWS;
  const active =
    activity?.provider ??
    providerRunningDescendants(
      new Map([...state.descriptors].filter(([key]) => !state.hiddenFromTrack.has(key))),
    );
  const rows: ProviderSubagentRow[] = [];
  const prefix = `${params.serverId}\0${params.parentAgentId}\0`;
  for (const [key, subagent] of state.descriptors) {
    if (!key.startsWith(prefix) || state.hiddenFromTrack.has(key)) continue;
    if (
      nestingSupported &&
      (subagent.parentSubagentId ?? null) !== (params.providerParentSubagentId ?? null)
    ) {
      continue;
    }
    rows.push({
      kind: "provider",
      id: subagent.id,
      parentAgentId: subagent.parentAgentId,
      provider: subagent.provider,
      title: subagent.title,
      description: subagent.description,
      subtitle: subagent.subtitle ?? null,
      status: subagent.status,
      hasActiveDescendants: nestingSupported && active.has(key),
      requiresAttention: subagent.status === "failed",
      createdAt: new Date(subagent.createdAt),
    });
  }
  rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return rows;
}

export function createProviderSubagentsForParentSelector(
  params: SelectSubagentsParams,
  supported: boolean,
  nestingSupported: boolean,
  activity?: SubagentActivity,
): (state: ProviderSubagentStoreSnapshot) => ProviderSubagentRow[] {
  let previousDescriptors: ProviderSubagentStoreSnapshot["descriptors"] | undefined;
  let previousHidden: ProviderSubagentStoreSnapshot["hiddenFromTrack"] | undefined;
  let previousRows = EMPTY_PROVIDER_SUBAGENT_ROWS;
  return (state) => {
    if (state.descriptors === previousDescriptors && state.hiddenFromTrack === previousHidden)
      return previousRows;
    previousDescriptors = state.descriptors;
    previousHidden = state.hiddenFromTrack;
    previousRows = selectProviderSubagentsForParent(
      state,
      params,
      supported,
      nestingSupported,
      activity,
    );
    return previousRows;
  };
}

export async function hydrateSubagentActivity(
  sessions: SubagentActivitySessions,
  activity: SubagentActivity,
  parent: AgentAddress,
): Promise<void> {
  const parentsByServer = new Map<string, string[]>();
  for (const address of managedSubtreeAddresses(activity, parent)) {
    const ids = parentsByServer.get(address.serverId) ?? [];
    ids.push(address.agentId);
    parentsByServer.set(address.serverId, ids);
  }
  await Promise.all(
    [...parentsByServer].map(async ([serverId, ids]) => {
      const session = sessions[serverId];
      if (session?.serverInfo?.features?.providerSubagents !== true) return;
      if (!session.client)
        throw new DaemonConnectionError("Host unavailable while discovering subagent activity");
      await hydrateProviderSubagents(session.client, serverId, ids);
    }),
  );
}

function useSubagentActivity(params: SelectSubagentsParams): SubagentActivity {
  const pendingArchiveKeys = usePendingArchiveAgentKeys();
  const sessions = useStoreWithEqualityFn(
    useSessionStore,
    (state) => state.sessions,
    sameActivitySessions,
  );
  const provider = useProviderSubagentStore(
    useShallow((state) => ({
      descriptors: state.descriptors,
      hiddenFromTrack: state.hiddenFromTrack,
    })),
  );
  const activity = getSubagentActivity({ sessions, ...provider, pendingArchiveKeys });
  useEffect(() => {
    void hydrateSubagentActivity(sessions, activity, {
      serverId: params.serverId,
      agentId: params.parentAgentId,
    }).catch(() => undefined);
  }, [sessions, activity, params.serverId, params.parentAgentId]);
  return activity;
}

export function useHasActiveDescendants(params: SelectSubagentsParams): boolean {
  const activity = useSubagentActivity(params);
  return params.providerParentSubagentId
    ? activity.provider.has(
        providerSubagentKey(params.serverId, params.parentAgentId, params.providerParentSubagentId),
      )
    : activity.managed.has(
        managedActivityKey({ serverId: params.serverId, agentId: params.parentAgentId }),
      );
}

export function useSubagentsForParent(params: SelectSubagentsParams): SubagentRow[] {
  const { serverId, parentAgentId, providerParentSubagentId } = params;
  const activity = useSubagentActivity(params);
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const selectPaseoRows = useMemo(
    () =>
      createSubagentsForParentSelector({ serverId, parentAgentId }, pendingArchiveIds, activity),
    [serverId, parentAgentId, pendingArchiveIds, activity],
  );
  const paseoRows = useStoreWithEqualityFn(useSessionStore, selectPaseoRows, equal);
  const supported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagents === true,
  );
  const nestingSupported = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.providerSubagentNesting === true,
  );
  const selectProviderRows = useMemo(
    () =>
      createProviderSubagentsForParentSelector(
        { serverId, parentAgentId, providerParentSubagentId },
        supported,
        nestingSupported,
        activity,
      ),
    [serverId, parentAgentId, providerParentSubagentId, supported, nestingSupported, activity],
  );
  const providerRows = useStoreWithEqualityFn(useProviderSubagentStore, selectProviderRows, equal);
  return useMemo(() => {
    if (providerParentSubagentId) return providerRows;
    if (providerRows.length === 0) return paseoRows;
    const rows = [...paseoRows, ...providerRows];
    rows.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    return rows;
  }, [providerParentSubagentId, paseoRows, providerRows]);
}
