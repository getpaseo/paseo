import { useSyncExternalStore } from "react";
import type { SessionContextValue } from "@/contexts/session-context";

// SessionData mirrors SessionContextValue so consumers can subscribe to a single source of truth.
export type SessionData = SessionContextValue;

interface SessionStoreState {
  sessions: Record<string, SessionData>;
}

interface SessionStore extends SessionStoreState {
  setSession: (serverId: string, data: SessionData) => void;
  updateSession: (serverId: string, partial: Partial<SessionData>) => void;
  clearSession: (serverId: string) => void;
  getSession: (serverId: string) => SessionData | undefined;
}

type SessionListener = () => void;

let storeState: SessionStoreState = { sessions: {} };
const listeners = new Set<SessionListener>();

const emit = () => {
  for (const listener of listeners) {
    listener();
  }
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
    return {
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

    return {
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
    const nextSessions = { ...prev.sessions };
    delete nextSessions[serverId];
    return { sessions: nextSessions };
  });
};

const getSession: SessionStore["getSession"] = (serverId) => {
  return storeState.sessions[serverId];
};

const subscribe = (listener: SessionListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

const buildSnapshot = (): SessionStore => ({
  sessions: storeState.sessions,
  setSession,
  updateSession,
  clearSession,
  getSession,
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
