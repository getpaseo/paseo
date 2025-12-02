import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import type { SessionContextValue } from "@/contexts/session-context";
import type { AgentDirectoryEntry } from "@/types/agent-directory";
import { isPerfLoggingEnabled, measurePayload, perfLog } from "@/utils/perf";

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

const SESSION_STORE_LOG_TAG = "[SessionStore]";
let sessionStoreUpdateCount = 0;

function logSessionStoreUpdate(
  type: "setSession" | "updateSession" | "clearSession" | "setAgentDirectory" | "clearAgentDirectory",
  serverId: string,
  payload?: unknown
) {
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
}

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

function areAgentDirectoriesEqual(left: AgentDirectoryEntry[] | undefined, right: AgentDirectoryEntry[]): boolean {
  if (!left) {
    return false;
  }
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    if (!other) {
      return false;
    }
    return (
      entry.id === other.id &&
      entry.status === other.status &&
      entry.serverId === other.serverId &&
      entry.lastActivityAt.getTime() === other.lastActivityAt.getTime() &&
      entry.title === other.title &&
      entry.cwd === other.cwd &&
      entry.provider === other.provider
    );
  });
}

export const useSessionStore = create<SessionStore>()(
  subscribeWithSelector((set, get) => ({
    sessions: {},
    agentDirectory: {},
    setSession: (serverId, data) => {
      set((prev) => {
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
    },
    updateSession: (serverId, partial) => {
      set((prev) => {
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
    },
    clearSession: (serverId) => {
      set((prev) => {
        if (!(serverId in prev.sessions)) {
          return prev;
        }
        logSessionStoreUpdate("clearSession", serverId);
        const nextSessions = { ...prev.sessions };
        delete nextSessions[serverId];
        return { ...prev, sessions: nextSessions };
      });
    },
    getSession: (serverId) => {
      return get().sessions[serverId];
    },
    setAgentDirectory: (serverId, agents) => {
      set((prev) => {
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
    },
    clearAgentDirectory: (serverId) => {
      set((prev) => {
        if (!(serverId in prev.agentDirectory)) {
          return prev;
        }
        logSessionStoreUpdate("clearAgentDirectory", serverId);
        const nextDirectory = { ...prev.agentDirectory };
        delete nextDirectory[serverId];
        return { ...prev, agentDirectory: nextDirectory };
      });
    },
    getAgentDirectory: (serverId) => {
      return get().agentDirectory[serverId];
    },
  }))
);
