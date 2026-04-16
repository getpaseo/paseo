/**
 * Global store for shared session state.
 * When a user joins a shared session via Colyseus, the room reference
 * is stored here so the agent panel and other components can react.
 */

import { useSyncExternalStore } from "react";

export interface SharedSessionUser {
  userId: string;
  username: string;
  avatarUrl: string;
  isOwner: boolean;
}

interface SharedSessionState {
  room: any | null; // Colyseus Room
  shareToken: string | null;
  sessionToken: string | null;
  accessLevel: string | null;
  currentUser: SharedSessionUser | null;
  ownerName: string | null;
  participants: Map<string, SharedParticipant>;
  enteredViaShare: boolean;
  sessionEnded: boolean;
}

export interface SharedParticipant {
  userId: string;
  username: string;
  avatarUrl: string;
  role: string;
  audioEnabled: boolean;
  isOnline: boolean;
}

// Restore from sessionStorage if available (survives navigation)
function loadPersistedState(): Partial<SharedSessionState> {
  try {
    if (typeof sessionStorage !== "undefined") {
      const raw = sessionStorage.getItem("hubcode_shared_session");
      if (raw) {
        const data = JSON.parse(raw);
        return {
          shareToken: data.shareToken ?? null,
          accessLevel: data.accessLevel ?? null,
          currentUser: data.currentUser ?? null,
          ownerName: data.ownerName ?? null,
          enteredViaShare: data.enteredViaShare ?? false,
        };
      }
    }
  } catch { /* ignore */ }
  return {};
}

const persisted = loadPersistedState();

let state: SharedSessionState = {
  room: null,
  shareToken: persisted.shareToken ?? null,
  sessionToken: (persisted as any).sessionToken ?? null,
  accessLevel: persisted.accessLevel ?? null,
  currentUser: persisted.currentUser ?? null,
  ownerName: persisted.ownerName ?? null,
  participants: new Map(),
  enteredViaShare: persisted.enteredViaShare ?? false,
  sessionEnded: false,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

export function setSharedSession(
  room: any,
  shareToken: string,
  accessLevel: string,
  currentUser?: SharedSessionUser | null,
  ownerName?: string | null,
  sessionToken?: string | null,
) {
  console.log("[shared-session] setSharedSession called, room:", !!room, "token:", shareToken, "user:", currentUser?.username);
  state = {
    ...state,
    room,
    shareToken,
    sessionToken: sessionToken ?? state.sessionToken,
    accessLevel,
    currentUser: currentUser ?? null,
    ownerName: ownerName ?? null,
    enteredViaShare: true,
    sessionEnded: false,
  };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("hubcode_shared_session", JSON.stringify({
        shareToken,
        sessionToken: sessionToken ?? state.sessionToken,
        accessLevel,
        currentUser,
        ownerName,
        enteredViaShare: true,
      }));
    }
  } catch { /* ignore */ }
  emit();

  // Listen for participant changes from Colyseus
  try {
    room.state?.participants?.onAdd?.((p: any, key: string) => {
      state.participants.set(key, {
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        role: p.role,
        audioEnabled: p.audioEnabled ?? false,
        isOnline: p.isOnline ?? true,
      });
      state = { ...state, participants: new Map(state.participants) };
      emit();

      p.onChange?.(() => {
        state.participants.set(key, {
          userId: p.userId,
          username: p.username,
          avatarUrl: p.avatarUrl,
          role: p.role,
          audioEnabled: p.audioEnabled ?? false,
          isOnline: p.isOnline ?? true,
        });
        state = { ...state, participants: new Map(state.participants) };
        emit();
      });
    });

    room.state?.participants?.onRemove?.((_p: any, key: string) => {
      state.participants.delete(key);
      state = { ...state, participants: new Map(state.participants) };
      emit();
    });

    room.onLeave?.(() => {
      clearSharedSession();
    });
  } catch {
    // Colyseus state listeners may not be available
  }
}

export function clearSharedSession() {
  if (state.room) {
    try {
      state.room.leave?.();
    } catch {
      // Ignore
    }
  }
  state = {
    room: null,
    shareToken: null,
    sessionToken: null,
    accessLevel: null,
    currentUser: null,
    ownerName: null,
    participants: new Map(),
    enteredViaShare: false,
    sessionEnded: true,
  };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("hubcode_shared_session");
    }
  } catch { /* ignore */ }
  emit();
}

export function getSharedSessionSnapshot(): SharedSessionState {
  return state;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useSharedSessionStore(): SharedSessionState {
  return useSyncExternalStore(subscribe, getSharedSessionSnapshot, getSharedSessionSnapshot);
}

export function useIsInSharedSession(): boolean {
  const { enteredViaShare } = useSharedSessionStore();
  return enteredViaShare;
}

export function useSharedParticipants(): Map<string, SharedParticipant> {
  const { participants } = useSharedSessionStore();
  return participants;
}

/**
 * Auto-reconnect to Colyseus room if we have persisted share data but no active room.
 * Call this in the app layout or agent panel.
 */
let reconnecting = false;
export async function reconnectIfNeeded(sessionTokenOverride?: string | null): Promise<void> {
  const sessionToken = sessionTokenOverride ?? state.sessionToken;
  if (reconnecting || state.room || !state.enteredViaShare || !state.shareToken || !sessionToken) {
    return;
  }
  reconnecting = true;
  try {
    const { joinSharedSession } = await import("@/hooks/sharing/colyseus-client");
    const room = await joinSharedSession({
      shareToken: state.shareToken,
      sessionToken,
    });
    state = { ...state, room };
    emit();
    console.log("[shared-session] auto-reconnected to Colyseus room");
  } catch (err) {
    console.warn("[shared-session] auto-reconnect failed:", err);
  } finally {
    reconnecting = false;
  }
}
