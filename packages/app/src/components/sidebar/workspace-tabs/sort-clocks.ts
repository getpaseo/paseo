import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  reuseEqualMap,
  sameAgentSortClock,
  sameWorkspaceSortClock,
  workspaceSortClock,
  type AgentSortClock,
  type WorkspaceSortClock,
} from "./nested-sort";

type SessionState = ReturnType<typeof useSessionStore.getState>;

const EMPTY_CLOCKS: ReadonlyMap<string, WorkspaceSortClock> = new Map();
const EMPTY_STATUS: ReadonlyMap<string, WorkspaceDescriptor["status"]> = new Map();
const EMPTY_AGENT_CLOCKS: ReadonlyMap<string, AgentSortClock> = new Map();

interface WorkspaceSidebarSnapshot {
  clocks: ReadonlyMap<string, WorkspaceSortClock>;
  statusByKey: ReadonlyMap<string, WorkspaceDescriptor["status"]>;
}

let workspaceSources: Array<[string, ReadonlyMap<string, WorkspaceDescriptor>]> = [];
let workspaceSnapshot: WorkspaceSidebarSnapshot = {
  clocks: EMPTY_CLOCKS,
  statusByKey: EMPTY_STATUS,
};

let agentSources: Array<[string, ReadonlyMap<string, Agent>]> = [];
let agentClocks: ReadonlyMap<string, AgentSortClock> = EMPTY_AGENT_CLOCKS;

/**
 * One scan of the workspace maps, shared by every row. Stream ticks leave the maps alone, so
 * later subscribers hit the same snapshot.
 */
function selectWorkspaceSidebarSnapshot(state: SessionState): WorkspaceSidebarSnapshot {
  const sources = Object.entries(state.sessions).map(
    ([serverId, session]) =>
      [serverId, session.workspaces] as [string, ReadonlyMap<string, WorkspaceDescriptor>],
  );
  if (sameSources(workspaceSources, sources)) return workspaceSnapshot;
  workspaceSources = sources;
  const clocks = new Map<string, WorkspaceSortClock>();
  const statusByKey = new Map<string, WorkspaceDescriptor["status"]>();
  for (const [serverId, workspaces] of sources) {
    for (const workspace of workspaces.values()) {
      const key = `${serverId}:${workspace.id}`;
      clocks.set(key, workspaceSortClock(workspace));
      statusByKey.set(key, workspace.status);
    }
  }
  // A workspace map can be replaced without any clock changing. Subscribers compare this
  // reference, so an equal rebuild must keep the previous one.
  const stableClocks = reuseEqualMap(workspaceSnapshot.clocks, clocks, sameWorkspaceSortClock);
  workspaceSnapshot = {
    clocks: stableClocks.size === 0 ? EMPTY_CLOCKS : stableClocks,
    statusByKey,
  };
  return workspaceSnapshot;
}

function selectAgentSortClocks(state: SessionState): ReadonlyMap<string, AgentSortClock> {
  const sources = Object.entries(state.sessions).map(
    ([serverId, session]) => [serverId, session.agents] as [string, ReadonlyMap<string, Agent>],
  );
  if (sameSources(agentSources, sources)) return agentClocks;
  agentSources = sources;
  const next = new Map<string, AgentSortClock>();
  for (const [, agents] of sources) {
    for (const agent of agents.values()) {
      const createdAt = agent.createdAt.getTime();
      next.set(`${agent.serverId}:${agent.id}`, {
        createdAt,
        lastPromptAt: agent.lastUserMessageAt?.getTime() ?? createdAt,
        workspaceKey: agent.workspaceId ? `${agent.serverId}:${agent.workspaceId}` : null,
      });
    }
  }
  const stable = reuseEqualMap(
    agentClocks,
    next.size === 0 ? EMPTY_AGENT_CLOCKS : next,
    sameAgentSortClock,
  );
  agentClocks = stable.size === 0 ? EMPTY_AGENT_CLOCKS : stable;
  return agentClocks;
}

function sameSources<T>(
  left: ReadonlyArray<readonly [string, T]>,
  right: ReadonlyArray<readonly [string, T]>,
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.[0] !== right[index]?.[0] || left[index]?.[1] !== right[index]?.[1]) {
      return false;
    }
  }
  return true;
}

export function selectWorkspaceStatusBuckets(
  state: SessionState,
): ReadonlyMap<string, WorkspaceDescriptor["status"]> {
  return selectWorkspaceSidebarSnapshot(state).statusByKey;
}

export function useWorkspaceSortClocks(): ReadonlyMap<string, WorkspaceSortClock> {
  return useSessionStore((state) => selectWorkspaceSidebarSnapshot(state).clocks);
}

export function useAgentSortClocks(): ReadonlyMap<string, AgentSortClock> {
  return useSessionStore(selectAgentSortClocks);
}
