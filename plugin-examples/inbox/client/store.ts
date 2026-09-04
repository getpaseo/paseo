import { type Lanes, projectLanes } from "./lanes";
import type { Agent, PaseoApi, Workspace } from "./types";

export interface InboxSnapshot {
  agents: ReadonlyMap<string, Agent>;
  workspaces: ReadonlyMap<string, Workspace>;
  /** Lanes across every workspace on the host. Panels filter separately. */
  lanes: Lanes;
  loaded: boolean;
  /** Set by a Command Center item; the board opens this card's peek and clears it. */
  pendingOpenAgentId: string | null;
}

export interface InboxStore {
  getSnapshot(): InboxSnapshot;
  subscribe(listener: () => void): () => void;
  /** Needs you count, or null when nothing needs you. The sidebar badge source. */
  getBadge(): number | null;
  requestOpen(agentId: string): void;
  clearPendingOpen(): void;
  dispose(): void;
}

const EMPTY_LANES: Lanes = { needsYou: [], working: [], done: [] };

/**
 * One store per plugin installation. It mirrors the daemon's active agent and
 * workspace directories from the host connection the plugin already borrows,
 * so surfaces read synchronously and never fetch on render.
 */
export function createInboxStore(paseo: PaseoApi): InboxStore {
  const agents = new Map<string, Agent>();
  const workspaces = new Map<string, Workspace>();
  const listeners = new Set<() => void>();
  let snapshot: InboxSnapshot = {
    agents,
    workspaces,
    lanes: EMPTY_LANES,
    loaded: false,
    pendingOpenAgentId: null,
  };
  let disposed = false;

  const publish = (patch: Partial<Pick<InboxSnapshot, "loaded" | "pendingOpenAgentId">> = {}) => {
    snapshot = {
      agents: new Map(agents),
      workspaces: new Map(workspaces),
      lanes: projectLanes(agents.values(), workspaces),
      loaded: patch.loaded ?? snapshot.loaded,
      pendingOpenAgentId:
        patch.pendingOpenAgentId === undefined
          ? snapshot.pendingOpenAgentId
          : patch.pendingOpenAgentId,
    };
    for (const listener of listeners) listener();
  };

  const unsubscribeAgents = paseo.agents.subscribe((update) => {
    if (update.kind === "upsert") agents.set(update.agent.id, update.agent);
    else agents.delete(update.agentId);
    publish();
  });
  const unsubscribeWorkspaces = paseo.workspaces.subscribe((update) => {
    if (update.kind === "upsert") workspaces.set(update.workspace.id, update.workspace);
    else workspaces.delete(update.id);
    publish();
  });

  const loadAgents = async () => {
    let cursor: string | undefined;
    for (;;) {
      const page = await paseo.agents.list({
        scope: "active",
        page: { limit: 200, ...(cursor ? { cursor } : {}) },
      });
      for (const entry of page.entries) agents.set(entry.agent.id, entry.agent);
      const next = page.pageInfo.hasMore ? page.pageInfo.nextCursor : null;
      if (!next || disposed) break;
      cursor = next;
    }
  };
  const loadWorkspaces = async () => {
    const page = await paseo.workspaces.list();
    for (const workspace of page.entries) workspaces.set(workspace.id, workspace);
  };
  void Promise.all([loadAgents(), loadWorkspaces()])
    .then(() => {
      if (!disposed) publish({ loaded: true });
      return undefined;
    })
    .catch((error: unknown) => {
      console.warn("[inbox] initial load failed", error);
      if (!disposed) publish({ loaded: true });
    });

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getBadge: () => snapshot.lanes.needsYou.length || null,
    requestOpen(agentId) {
      publish({ pendingOpenAgentId: agentId });
    },
    clearPendingOpen() {
      if (snapshot.pendingOpenAgentId !== null) publish({ pendingOpenAgentId: null });
    },
    dispose() {
      disposed = true;
      unsubscribeAgents();
      unsubscribeWorkspaces();
      listeners.clear();
    },
  };
}

let current: InboxStore | null = null;

export function setInboxStore(store: InboxStore | null): void {
  current = store;
}

export function getInboxStore(): InboxStore | null {
  return current;
}
