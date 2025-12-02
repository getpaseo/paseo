import { useSyncExternalStore } from "react";
import type { SessionContextValue } from "@/contexts/session-context";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { isPerfLoggingEnabled, measurePayload, perfLog } from "@/utils/perf";

// SessionData mirrors SessionContextValue so consumers can subscribe to a single source of truth.
export type SessionData = SessionContextValue;

interface SessionStoreState {
  sessions: Record<string, SessionData>;
  agentDirectory: Record<string, AgentDirectoryEntry[]>;
}

interface SessionStore extends SessionStoreState {
  setSession: (serverId: string, data: SessionData) => void;
  updateSession: (serverId: string, partial: Partial<SessionData>) => void;
  clearSession: (serverId: string) => void;
  getSession: (serverId: string) => SessionData | undefined;
  setAgentDirectory: (serverId: string, agents: AgentDirectoryEntry[]) => void;
  clearAgentDirectory: (serverId: string) => void;
  getAgentDirectory: (serverId: string) => AgentDirectoryEntry[] | undefined;
}

type SessionListener = () => void;

let storeState: SessionStoreState = { sessions: {}, agentDirectory: {} };
const listeners = new Set<SessionListener>();
const SESSION_STORE_LOG_TAG = "[SessionStore]";
let sessionStoreUpdateCount = 0;

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
};

const logSessionStoreUpdate = (
  type: "setSession" | "updateSession" | "clearSession" | "setAgentDirectory" | "clearAgentDirectory",
  serverId: string,
  payload?: unknown
) => {
  if (!isPerfLoggingEnabled()) {
    return;
  }
  sessionStoreUpdateCount += 1;
  const metrics = payload ? measurePayload(payload) : null;
  perfLog(SESSION_STORE_LOG_TAG, {
    event: type,
    serverId,
    updateCount: sessionStoreUpdateCount,
    payloadApproxBytes: metrics?.approxBytes ?? 0,
    payloadFieldCount: metrics?.fieldCount ?? 0,
    timestamp: Date.now(),
  });
};

const updateStoreState = (updater: (prev: SessionStoreState) => SessionStoreState) => {
  const next = updater(storeState);
  if (next === storeState) {
    return;
  }
  storeState = next;
  emit();
};

const setSession: SessionStore["setSession"] = (serverId, data) => {
  updateStoreState((prev) => {
    if (prev.sessions[serverId] === data) {
      return prev;
    }
    logSessionStoreUpdate("setSession", serverId, data);
    return {
      ...prev,
      sessions: {
        ...prev.sessions,
        [serverId]: data,
      },
    };
  });
};

const updateSession: SessionStore["updateSession"] = (serverId, partial) => {
  updateStoreState((prev) => {
    const existing = prev.sessions[serverId];
    const next: SessionData | undefined = existing
      ? { ...existing, ...partial, serverId }
      : partial.serverId
        ? ({ ...(partial as SessionData), serverId })
        : undefined;

    if (!next) {
      return prev;
    }

    if (existing && shallowEqual(existing, next)) {
      return prev;
    }

    logSessionStoreUpdate("updateSession", serverId, partial);
    return {
      ...prev,
      sessions: {
        ...prev.sessions,
        [serverId]: next,
      },
    };
  });
};

const clearSession: SessionStore["clearSession"] = (serverId) => {
  updateStoreState((prev) => {
    if (!(serverId in prev.sessions)) {
      return prev;
    }
    logSessionStoreUpdate("clearSession", serverId);
    const nextSessions = { ...prev.sessions };
    delete nextSessions[serverId];
    return { ...prev, sessions: nextSessions };
  });
};

const getSession: SessionStore["getSession"] = (serverId) => {
  return storeState.sessions[serverId];
};

const setAgentDirectory: SessionStore["setAgentDirectory"] = (serverId, agents) => {
  updateStoreState((prev) => {
    const existing = prev.agentDirectory[serverId];
    if (existing && areAgentDirectoriesEqual(existing, agents)) {
      return prev;
    }
    logSessionStoreUpdate("setAgentDirectory", serverId, { agentCount: agents.length });
    return {
      ...prev,
      agentDirectory: {
        ...prev.agentDirectory,
        [serverId]: agents,
      },
    };
  });
};

const clearAgentDirectory: SessionStore["clearAgentDirectory"] = (serverId) => {
  updateStoreState((prev) => {
    if (!(serverId in prev.agentDirectory)) {
      return prev;
    }
    logSessionStoreUpdate("clearAgentDirectory", serverId);
    const nextDirectory = { ...prev.agentDirectory };
    delete nextDirectory[serverId];
    return { ...prev, agentDirectory: nextDirectory };
  });
};

const getAgentDirectory: SessionStore["getAgentDirectory"] = (serverId) => {
  return storeState.agentDirectory[serverId];
};

const subscribe = (listener: SessionListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const buildSnapshot = (): SessionStore => ({
  sessions: storeState.sessions,
  agentDirectory: storeState.agentDirectory,
  setSession,
  updateSession,
  clearSession,
  getSession,
  setAgentDirectory,
  clearAgentDirectory,
  getAgentDirectory,
});

const shallowEqual = (left: SessionData, right: SessionData): boolean => {
  if (left === right) {
    return true;
  }
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  for (const [key, value] of leftEntries) {
    if (right[key as keyof SessionData] !== value) {
      return false;
    }
  }
  return true;
};

export function useSessionStore<T>(selector: (state: SessionStore) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(buildSnapshot()),
    () => selector(buildSnapshot())
  );
}

function areAgentDirectoriesEqual(
  left: AgentDirectoryEntry[] | undefined,
  right: AgentDirectoryEntry[]
): boolean {
  if (!left) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  const leftById = new Map(left.map((entry) => [entry.id, entry]));
  for (const entry of right) {
    const previous = leftById.get(entry.id);
    if (!previous) {
      return false;
    }
    if (
      previous.serverId !== entry.serverId ||
      previous.title !== entry.title ||
      previous.status !== entry.status ||
      previous.provider !== entry.provider ||
      previous.cwd !== entry.cwd ||
      previous.lastActivityAt.getTime() !== entry.lastActivityAt.getTime()
    ) {
      return false;
    }
  }
  return true;
}
