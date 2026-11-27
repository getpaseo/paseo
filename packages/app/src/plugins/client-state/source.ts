import { i18n } from "@/i18n/i18next";
import type { PluginClientSnapshot, PluginClientStateSource } from "@getpaseo/plugin/client/host";
import type { PluginTerminalSnapshot } from "@getpaseo/plugin";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import { connectedPluginHosts } from "./connected-hosts";
import { pluginTerminals } from "./terminals";
import { entityRefs } from "./refs";
import {
  createPluginAgentSnapshot,
  createPluginProjectSnapshot,
  createPluginWorkspaceSnapshot,
} from "./snapshots";

export interface PluginConnectedHostsSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly string[];
}

export interface PluginTerminalsSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): readonly PluginTerminalSnapshot[];
  getErrors?(): ReadonlyMap<string, Error>;
}

const emptyTerminals: readonly PluginTerminalSnapshot[] = Object.freeze([]);
const listeners = new Set<() => void>();
let releaseStores: (() => void) | null = null;

// Every plugin host shares one subscription to each app store.
function subscribeStores(listener: () => void): () => void {
  if (!releaseStores) {
    const notify = () => {
      for (const subscriber of listeners) subscriber();
    };
    i18n.on("languageChanged", notify);
    const releaseSession = useSessionStore.subscribe((state) => {
      for (const hostId of hostProjections.keys()) {
        if (!state.sessions[hostId]) hostProjections.delete(hostId);
      }
      notify();
    });
    const releaseCreate = useCreateFlowStore.subscribe(notify);
    releaseStores = () => {
      i18n.off("languageChanged", notify);
      releaseSession();
      releaseCreate();
    };
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && releaseStores) {
      releaseStores();
      releaseStores = null;
      hostProjections.clear();
    }
  };
}

interface HostProjection {
  language: string;
  workspaces: SessionState["workspaces"];
  agents: SessionState["agents"];
  projects: SessionState["projects"];
  activity: SessionState["workspaceAgentActivity"];
  pending: ReturnType<typeof useCreateFlowStore.getState>["pendingByDraftId"];
  snapshot: Omit<PluginClientSnapshot, "terminals">;
  workspaceById: Map<string, PluginClientSnapshot["workspaces"][number]>;
  agentById: Map<string, PluginClientSnapshot["agents"][number]>;
  projectById: Map<string, PluginClientSnapshot["projects"][number]>;
}
const hostProjections = new Map<string, HostProjection>();

function projectHost(hostId: string): HostProjection | null {
  const session = useSessionStore.getState().sessions[hostId];
  if (!session) {
    hostProjections.delete(hostId);
    return null;
  }
  const pending = useCreateFlowStore.getState().pendingByDraftId;
  const previous = hostProjections.get(hostId);
  const unchanged =
    previous &&
    previous.language === i18n.language &&
    previous.workspaces === session.workspaces &&
    previous.agents === session.agents &&
    previous.projects === session.projects &&
    previous.activity === session.workspaceAgentActivity &&
    previous.pending === pending;
  if (unchanged) return previous;
  const workspaces = Array.from(session.workspaces.values(), (workspace) => {
    const activity = session.workspaceAgentActivity.get(workspace.id);
    const root = activity ? session.agents.get(activity.agentId) : undefined;
    return createPluginWorkspaceSnapshot(workspace, hostId, {
      pendingCreateAttempts: pending,
      workspaceAgentActivity: session.workspaceAgentActivity,
      parentAgent: root ? createPluginAgentSnapshot(root, workspace.id).parentAgent : null,
    });
  });
  const agents: PluginClientSnapshot["agents"][number][] = [];
  for (const agent of session.agents.values()) {
    const workspaceId = normalizeWorkspaceOpaqueId(agent.workspaceId);
    if (!workspaceId || agent.archivedAt) continue;
    agents.push(createPluginAgentSnapshot(agent, workspaceId));
  }
  const projects = Array.from(session.projects.values(), (project) =>
    createPluginProjectSnapshot(project, hostId),
  );
  const projection: HostProjection = {
    language: i18n.language,
    workspaces: session.workspaces,
    agents: session.agents,
    projects: session.projects,
    activity: session.workspaceAgentActivity,
    pending,
    snapshot: {
      workspaces: Object.freeze(workspaces),
      agents: Object.freeze(agents),
      projects: Object.freeze(projects),
    },
    workspaceById: new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    agentById: new Map(agents.map((agent) => [agent.id, agent])),
    projectById: new Map(projects.map((project) => [project.ref.id, project])),
  };
  hostProjections.set(hostId, projection);
  return projection;
}

function sameSequence<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** A host scope only resolves legacy string ids. Ref lookups and collections span hosts. */
export function createPluginClientStateSource(
  serverId?: string,
  options: { hosts?: PluginConnectedHostsSource; terminals?: PluginTerminalsSource } = {},
): PluginClientStateSource {
  const terminals = options.terminals ?? pluginTerminals;
  const hosts = options.hosts ?? connectedPluginHosts;
  const subscribers = new Set<() => void>();
  const terminalSubscribers = new Set<() => void>();
  let releaseTerminals: (() => void) | null = null;
  let release: (() => void) | null = null;
  let previousProjections: readonly HostProjection[] = [];
  let previousTerminals = emptyTerminals;
  let previousTerminalErrors: ReadonlyMap<string, Error> | undefined;
  let snapshot: PluginClientSnapshot = {
    workspaces: [],
    agents: [],
    projects: [],
    terminals: emptyTerminals,
  };
  function getSnapshot(): PluginClientSnapshot {
    const ids = hosts.getSnapshot();
    const projections: HostProjection[] = [];
    for (const id of ids) {
      const projection = projectHost(id);
      if (projection) projections.push(projection);
    }
    const terminalSnapshots = terminals.getSnapshot();
    const terminalErrors = terminals.getErrors?.();
    if (
      sameSequence(previousProjections, projections) &&
      previousTerminals === terminalSnapshots &&
      previousTerminalErrors === terminalErrors
    )
      return snapshot;
    previousProjections = projections;
    previousTerminals = terminalSnapshots;
    previousTerminalErrors = terminalErrors;
    snapshot = Object.freeze({
      workspaces: Object.freeze(projections.flatMap((host) => host.snapshot.workspaces)),
      agents: Object.freeze(projections.flatMap((host) => host.snapshot.agents)),
      projects: Object.freeze(projections.flatMap((host) => host.snapshot.projects)),
      terminals: terminalSnapshots,
      terminalErrors,
    });
    return snapshot;
  }
  return {
    subscribe(listener, subscriptionOptions) {
      subscribers.add(listener);
      if (subscriptionOptions?.terminals) {
        terminalSubscribers.add(listener);
        releaseTerminals ??= terminals.subscribe(() => {
          for (const subscriber of terminalSubscribers) subscriber();
        });
      }
      if (!release) {
        const notify = () => {
          for (const subscriber of subscribers) subscriber();
        };
        const releaseStore = subscribeStores(notify);
        const releaseHosts = hosts.subscribe(notify);
        release = () => {
          releaseStore();
          releaseHosts();
        };
      }
      return () => {
        subscribers.delete(listener);
        terminalSubscribers.delete(listener);
        if (terminalSubscribers.size === 0 && releaseTerminals) {
          releaseTerminals();
          releaseTerminals = null;
        }
        if (subscribers.size === 0 && release) {
          release();
          release = null;
          previousProjections = [];
          previousTerminals = emptyTerminals;
          previousTerminalErrors = undefined;
          snapshot = { workspaces: [], agents: [], projects: [], terminals: emptyTerminals };
        }
      };
    },
    getSnapshot,
    getWorkspace(reference) {
      const ref =
        typeof reference === "string" && serverId
          ? entityRefs.workspace(serverId, reference)
          : reference;
      if (typeof ref === "string") return null;
      return projectHost(ref.hostId)?.workspaceById.get(ref.id) ?? null;
    },
    getAgent(reference) {
      const ref =
        typeof reference === "string" && serverId
          ? entityRefs.agent(serverId, reference)
          : reference;
      if (typeof ref === "string") return null;
      const projected = projectHost(ref.hostId)?.agentById.get(ref.id);
      if (projected) return projected;
      const session = useSessionStore.getState().sessions[ref.hostId];
      const detail = session?.agents.get(ref.id) ?? session?.agentDetails.get(ref.id);
      const workspaceId = normalizeWorkspaceOpaqueId(detail?.workspaceId);
      return detail && workspaceId ? createPluginAgentSnapshot(detail, workspaceId) : null;
    },
    getProject: (ref) => projectHost(ref.hostId)?.projectById.get(ref.id) ?? null,
    getTerminal(ref) {
      const error = terminals.getErrors?.().get(ref.hostId);
      if (error) throw error;
      return terminals.getSnapshot().find((terminal) => terminal.ref === ref) ?? null;
    },
  };
}
