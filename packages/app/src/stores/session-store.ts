import { create } from "zustand";
import type { SessionContextValue } from "@/contexts/session-context";

// SessionData mirrors SessionContextValue so consumers can subscribe to a single source of truth.
export type SessionData = SessionContextValue;

interface SessionStore {
  sessions: Record<string, SessionData>;
  setSession: (serverId: string, data: SessionData) => void;
  updateSession: (serverId: string, partial: Partial<SessionData>) => void;
  clearSession: (serverId: string) => void;
  getSession: (serverId: string) => SessionData | undefined;
}

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: {},
  setSession: (serverId, data) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [serverId]: data,
      },
    }));
  },
  updateSession: (serverId, partial) => {
    set((state) => {
      const existing = state.sessions[serverId];
      const next: SessionData | undefined = existing
        ? { ...existing, ...partial, serverId }
        : (partial.serverId ? { ...(partial as SessionData), serverId } : undefined);

      if (!next) {
        return state;
      }

      return {
        sessions: {
          ...state.sessions,
          [serverId]: next,
        },
      };
    });
  },
  clearSession: (serverId) => {
    set((state) => {
      if (!(serverId in state.sessions)) {
        return state;
      }
      const nextSessions = { ...state.sessions };
      delete nextSessions[serverId];
      return { sessions: nextSessions };
    });
  },
  getSession: (serverId) => get().sessions[serverId],
}));
