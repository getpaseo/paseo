import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import {
  composeWorkspaceStructure,
  createWorkspaceStructureProjectsSelector,
  selectHasHydratedWorkspaces,
  selectHydratedWorkspaceServerIds,
  selectWorkspaceDirectoryServerIds,
  selectHasWorkspaces,
  selectProjectOrder,
  selectRecommendedProjectPaths,
  selectWorkspace,
  selectWorkspaceDirectory,
  selectWorkspaceExists,
  selectWorkspaceFields,
  selectWorkspaceKeys,
  selectWorkspaceOrderByScope,
  selectWorkspaceStatusesForBadges,
  workspaceEqualityFns,
  type WorkspaceStructure,
} from "./selectors";
import {
  normalizeProjectDescriptor,
  normalizeWorkspaceDescriptor,
  selectAgentTimelineState,
  selectAgentTurnPresentation,
  useSessionStore,
  type Agent,
  type AgentFileExplorerState,
  type AgentTimelineCursorState,
  type AgentTimelineState,
  type DaemonServerInfo,
  type ExplorerDirectory,
  type ExplorerEntry,
  type ExplorerEntryKind,
  type ExplorerEncoding,
  type ExplorerFile,
  type ExplorerFileKind,
  type ProjectDescriptor,
  type SessionState,
  type WorkspaceDescriptor,
} from "../session-store";
import type { ViewedTimelineUiBridge } from "@/timeline/viewed-timeline-sync";
import type { WorkspaceAgentActivity } from "@/utils/workspace-agent-activity";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem, TodoEntry } from "@/types/stream";
import type { DesktopBadgeWorkspaceStatus } from "@/utils/desktop-badge-state";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";

// These are the ONLY supported ways to read workspaces from the session store.
// Do not write raw `useSessionStore` selectors that return the workspaces Map, a session object,
// or the sessions dict — it breaks re-render isolation.

export type {
  Agent,
  AgentFileExplorerState,
  AgentTimelineCursorState,
  AgentTimelineState,
  DaemonServerInfo,
  ExplorerDirectory,
  ExplorerEntry,
  ExplorerEntryKind,
  ExplorerEncoding,
  ExplorerFile,
  ExplorerFileKind,
  ProjectDescriptor,
  WorkspaceDescriptor,
} from "../session-store";

export type {
  DesktopBadgeWorkspaceStatus,
  WorkspaceStructure,
  WorkspaceStructureProject,
} from "./selectors";

export { normalizeProjectDescriptor, normalizeWorkspaceDescriptor };

type Equality<T> = (left: T, right: T) => boolean;

export interface ConnectionView {
  exists: boolean;
  serverInfo: DaemonServerInfo | null;
}

export interface AgentDirectoryView {
  agents: ReadonlyMap<string, Agent>;
  agentDetails: ReadonlyMap<string, Agent>;
  hasHydratedAgents: boolean;
}

export interface WorkspaceDirectoryView {
  serverId: string;
  workspaces: ReadonlyMap<string, WorkspaceDescriptor>;
  projects: ReadonlyMap<string, ProjectDescriptor>;
  hasHydratedWorkspaces: boolean;
  hasWorkspaceDirectorySnapshot: boolean;
  workspaceAgentActivity: ReadonlyMap<string, WorkspaceAgentActivity>;
}

const EMPTY_AGENT_DIRECTORY: AgentDirectoryView = {
  agents: new Map(),
  agentDetails: new Map(),
  hasHydratedAgents: false,
};

function connectionView(session: SessionState | undefined): ConnectionView {
  return {
    exists: Boolean(session),
    serverInfo: session?.serverInfo ?? null,
  };
}

function agentDirectoryView(session: SessionState | undefined): AgentDirectoryView {
  if (!session) return EMPTY_AGENT_DIRECTORY;
  return {
    agents: session.agents,
    agentDetails: session.agentDetails,
    hasHydratedAgents: session.hasHydratedAgents,
  };
}

function workspaceDirectoryView(
  serverId: string,
  session: SessionState | undefined,
): WorkspaceDirectoryView {
  return {
    serverId,
    workspaces: session?.workspaces ?? new Map(),
    projects: session?.projects ?? new Map(),
    hasHydratedWorkspaces: session?.hasHydratedWorkspaces ?? false,
    hasWorkspaceDirectorySnapshot: session?.hasWorkspaceDirectorySnapshot ?? false,
    workspaceAgentActivity: session?.workspaceAgentActivity ?? new Map(),
  };
}

export function useConnection<T>(
  serverId: string | null | undefined,
  project: (connection: ConnectionView) => T,
  equality: Equality<T> = Object.is,
): T {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => project(connectionView(serverId ? state.sessions[serverId] : undefined)),
    equality,
  );
}

export function useConnections<T>(
  serverIds: readonly string[],
  project: (connections: ReadonlyMap<string, ConnectionView>) => T,
  equality: Equality<T> = Object.is,
): T {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      project(
        new Map(serverIds.map((serverId) => [serverId, connectionView(state.sessions[serverId])])),
      ),
    equality,
  );
}

export function useServerFeature(
  serverId: string | null | undefined,
  feature: keyof NonNullable<DaemonServerInfo["features"]>,
): boolean {
  return useConnection(serverId, ({ serverInfo }) => serverInfo?.features?.[feature] === true);
}

export function useHasHostServerInfo(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => Boolean(serverId && state.sessions[serverId]?.serverInfo),
    Object.is,
  );
}

export function useAgentDirectoryFields<T>(
  serverId: string | null,
  project: (directory: AgentDirectoryView) => T,
  equality: Equality<T> = Object.is,
): T {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => project(agentDirectoryView(serverId ? state.sessions[serverId] : undefined)),
    equality,
  );
}

export function useAgentDirectories<T>(
  serverIds: readonly string[],
  project: (directories: ReadonlyMap<string, AgentDirectoryView>) => T,
  equality: Equality<T> = Object.is,
): T {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      project(
        new Map(
          serverIds.map((serverId) => [serverId, agentDirectoryView(state.sessions[serverId])]),
        ),
      ),
    equality,
  );
}

export function useAgent(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
): Agent | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId || !agentId) return null;
      const session = state.sessions[serverId];
      return session?.agents.get(agentId) ?? session?.agentDetails.get(agentId) ?? null;
    },
    Object.is,
  );
}

export function useAgentFields<T>(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
  project: (agent: Agent) => T,
  equality: Equality<T | null> = workspaceEqualityFns.deep,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId || !agentId) return null;
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return agent ? project(agent) : null;
    },
    equality,
  );
}

export function useActiveAgent(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
): Agent | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      serverId && agentId ? (state.sessions[serverId]?.agents.get(agentId) ?? null) : null,
    Object.is,
  );
}

export function useActiveAgentFields<T>(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
  project: (agent: Agent) => T,
  equality: Equality<T | null> = workspaceEqualityFns.deep,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const agent = serverId && agentId ? state.sessions[serverId]?.agents.get(agentId) : undefined;
      return agent ? project(agent) : null;
    },
    equality,
  );
}

export function useAgentWorkspaceId(
  serverId: string | null | undefined,
  agentId: string | null | undefined,
): string | null {
  return useActiveAgentFields(serverId, agentId, (agent) => agent.workspaceId ?? null, Object.is);
}

export function useAgentBelongsToWorkspace(
  serverId: string | null,
  agentId: string | null,
  workspaceId: string | null,
): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId || !agentId || !workspaceId) return false;
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      return (
        normalizeWorkspaceOpaqueId(agent?.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
      );
    },
    Object.is,
  );
}

export function useConnectedDesktopManagedHostIds(): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      Object.entries(state.sessions)
        .filter(([, session]) => session.serverInfo?.desktopManaged === true)
        .map(([serverId]) => serverId)
        .sort(),
    workspaceEqualityFns.deep,
  );
}

export function useFileExplorer(
  serverId: string | null,
  scopeKey: string | null,
): AgentFileExplorerState | undefined {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      serverId && scopeKey ? state.sessions[serverId]?.fileExplorer.get(scopeKey) : undefined,
    Object.is,
  );
}

export function useAgentStreamView(serverId: string, agentId: string) {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const session = state.sessions[serverId];
      return {
        head: session?.agentStreamHead.get(agentId),
        timelineEpoch: session?.agentTimelineCursor.get(agentId)?.epoch ?? null,
        hasNewerTimeline: session?.agentTimelineHasNewer.get(agentId) === true,
      };
    },
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceDirectoryStatus(serverId: string | null) {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => ({
      hasHydratedWorkspaces: serverId
        ? (state.sessions[serverId]?.hasHydratedWorkspaces ?? false)
        : false,
    }),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceDirectories<T>(
  serverIds: readonly string[],
  project: (directories: ReadonlyMap<string, WorkspaceDirectoryView>) => T,
  equality: Equality<T> = Object.is,
): T {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      project(
        new Map(
          serverIds.map((serverId) => [
            serverId,
            workspaceDirectoryView(serverId, state.sessions[serverId]),
          ]),
        ),
      ),
    equality,
  );
}

export function useAgentTimeline(
  serverId: string | null,
  agentId: string | null,
): {
  timeline: AgentTimelineState;
  cursor: AgentTimelineCursorState | null;
  isLoadingOlder: boolean;
};
export function useAgentTimeline<T>(
  serverId: string | null,
  agentId: string | null,
  project: (timeline: AgentTimelineState, meta: { isLoadingOlder: boolean }) => T,
  equality?: Equality<T>,
): T;
export function useAgentTimeline(
  serverId: string | null,
  agentId: string | null,
  project?: (timeline: AgentTimelineState, meta: { isLoadingOlder: boolean }) => unknown,
  equality: Equality<unknown> = workspaceEqualityFns.deep,
): unknown {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const session = serverId ? state.sessions[serverId] : undefined;
      const timeline = selectAgentTimelineState(session, agentId ?? "");
      const isLoadingOlder = agentId
        ? session?.agentTimelineOlderFetchInFlight.get(agentId) === true
        : false;
      if (project) return project(timeline, { isLoadingOlder });
      return {
        timeline,
        cursor: timeline.status === "synced" ? timeline.range : null,
        isLoadingOlder,
      };
    },
    equality,
  );
}

export interface AgentConversationView {
  tasks: TodoEntry[] | undefined;
  streamItems: StreamItem[];
  messageSubmissions: SessionState["messageSubmissions"] extends Map<string, infer Value>
    ? Value | undefined
    : never;
  pendingPermissions: PendingPermission[];
  turn: ReturnType<typeof selectAgentTurnPresentation>;
  timeline: AgentTimelineState;
  viewedTimelineSync: ViewedTimelineUiBridge | null;
  isInitializing: boolean;
  historySyncGeneration: number;
  agentHistorySyncGeneration: number;
}

function agentConversationView(
  session: SessionState | undefined,
  agentId: string,
): AgentConversationView {
  return {
    get tasks() {
      return session?.agentTasks.get(agentId);
    },
    get streamItems() {
      return session?.agentStreamTail.get(agentId) ?? [];
    },
    get messageSubmissions() {
      return session?.messageSubmissions.get(agentId);
    },
    get pendingPermissions() {
      return Array.from(session?.pendingPermissions.values() ?? []).filter(
        (permission) => permission.agentId === agentId,
      );
    },
    get turn() {
      return selectAgentTurnPresentation(session, agentId);
    },
    get timeline() {
      return selectAgentTimelineState(session, agentId);
    },
    get viewedTimelineSync() {
      return session?.viewedTimelineSync ?? null;
    },
    get isInitializing() {
      return session?.initializingAgents.get(agentId) ?? false;
    },
    get historySyncGeneration() {
      return session?.historySyncGeneration ?? 0;
    },
    get agentHistorySyncGeneration() {
      return session?.agentHistorySyncGeneration.get(agentId) ?? -1;
    },
  };
}

export function useAgentConversation(
  serverId: string,
  agentId: string | null | undefined,
): AgentConversationView;
export function useAgentConversation<T>(
  serverId: string,
  agentId: string | null | undefined,
  project: (conversation: AgentConversationView) => T,
  equality?: Equality<T>,
): T;
export function useAgentConversation(
  serverId: string,
  agentId: string | null | undefined,
  project: (conversation: AgentConversationView) => unknown = (conversation) => conversation,
  equality: Equality<unknown> = workspaceEqualityFns.deep,
): unknown {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => project(agentConversationView(state.sessions[serverId], agentId ?? "")),
    equality,
  );
}

export function useComposerSession(serverId: string, agentId: string) {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const session = state.sessions[serverId];
      let hasPendingPermission = false;
      for (const permission of session?.pendingPermissions.values() ?? []) {
        if (permission.agentId === agentId) {
          hasPendingPermission = true;
          break;
        }
      }
      return {
        queuedMessages: session?.queuedMessages.get(agentId) ?? [],
        hasPendingPermission,
      };
    },
    workspaceEqualityFns.deep,
  );
}

export function useAgentTurn(
  serverId: string | null,
  agentId: string | null,
): ReturnType<typeof selectAgentTurnPresentation>;
export function useAgentTurn<T>(
  serverId: string | null,
  agentId: string | null,
  project: (turn: ReturnType<typeof selectAgentTurnPresentation>) => T,
  equality?: Equality<T>,
): T;
export function useAgentTurn(
  serverId: string | null,
  agentId: string | null,
  project?: (turn: ReturnType<typeof selectAgentTurnPresentation>) => unknown,
  equality: Equality<unknown> = workspaceEqualityFns.deep,
): unknown {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const turn = selectAgentTurnPresentation(
        serverId ? state.sessions[serverId] : undefined,
        agentId ?? "",
      );
      return project ? project(turn) : turn;
    },
    equality,
  );
}

export function useSessionFocus(serverId: string | null) {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      const session = serverId ? state.sessions[serverId] : undefined;
      return {
        focusedAgentId: session?.focusedAgentId ?? null,
        focusedTerminalId: session?.focusedTerminalId ?? null,
      };
    },
    workspaceEqualityFns.deep,
  );
}

export function useViewedTimelineSync(serverId: string | null): ViewedTimelineUiBridge | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => (serverId ? (state.sessions[serverId]?.viewedTimelineSync ?? null) : null),
    Object.is,
  );
}

export function useWorkspace(
  serverId: string | null,
  workspaceId: string | null,
): WorkspaceDescriptor | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspace(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceByDirectory(
  serverId: string | null,
  workspaceDirectory: string | null | undefined,
): WorkspaceDescriptor | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId || !workspaceDirectory) return null;
      for (const workspace of state.sessions[serverId]?.workspaces.values() ?? []) {
        if (workspace.workspaceDirectory === workspaceDirectory) return workspace;
      }
      return null;
    },
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceByDirectoryFields<T>(
  serverId: string | null,
  workspaceDirectory: string | null | undefined,
  project: (workspace: WorkspaceDescriptor) => T,
  equality: Equality<T | null> = workspaceEqualityFns.deep,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => {
      if (!serverId || !workspaceDirectory) return null;
      for (const workspace of state.sessions[serverId]?.workspaces.values() ?? []) {
        if (workspace.workspaceDirectory === workspaceDirectory) return project(workspace);
      }
      return null;
    },
    equality,
  );
}

export function useWorkspaceFields<T>(
  serverId: string | null,
  workspaceId: string | null,
  project: (w: WorkspaceDescriptor) => T,
  equality: Equality<T | null> = workspaceEqualityFns.deep,
): T | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceFields(state, serverId, workspaceId, project),
    equality,
  );
}

export function useWorkspaceExists(serverId: string | null, workspaceId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceExists(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useHasHydratedWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHasHydratedWorkspaces(state, serverId),
    workspaceEqualityFns.identity,
  );
}

export function useHydratedWorkspaceServerIds(serverIds: string[]): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHydratedWorkspaceServerIds(state, serverIds),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceDirectoryServerIds(serverIds: string[]): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceDirectoryServerIds(state, serverIds),
    workspaceEqualityFns.deep,
  );
}

export function useWorkspaceDirectory(
  serverId: string | null,
  workspaceId: string | null,
): string | null {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceDirectory(state, serverId, workspaceId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceStructure(serverIds: string[]): WorkspaceStructure {
  const selectProjects = useMemo(
    () => createWorkspaceStructureProjectsSelector(serverIds),
    [serverIds],
  );
  const projects = useStoreWithEqualityFn(
    useSessionStore,
    selectProjects,
    workspaceEqualityFns.deep,
  );
  const projectOrder = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) => selectProjectOrder(state),
    workspaceEqualityFns.deep,
  );
  const workspaceOrderByScope = useStoreWithEqualityFn(
    useSidebarOrderStore,
    (state) => selectWorkspaceOrderByScope(state),
    workspaceEqualityFns.deep,
  );

  return useMemo(
    () =>
      composeWorkspaceStructure({
        projects,
        projectOrder,
        workspaceOrderByScope,
      }),
    [projectOrder, projects, workspaceOrderByScope],
  );
}

export function useWorkspaceKeys(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceKeys(state, serverId),
    workspaceEqualityFns.deep,
  );
}

export function useRecommendedProjectPaths(serverId: string | null): string[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectRecommendedProjectPaths(state, serverId),
    workspaceEqualityFns.deep,
  );
}

export function useHasWorkspaces(serverId: string | null): boolean {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectHasWorkspaces(state, serverId),
    workspaceEqualityFns.identity,
  );
}

export function useWorkspaceStatusesForBadges(): DesktopBadgeWorkspaceStatus[] {
  return useStoreWithEqualityFn(
    useSessionStore,
    (state) => selectWorkspaceStatusesForBadges(state),
    workspaceEqualityFns.deep,
  );
}
