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
  /** Recipient-only scope: when set, sidebar is restricted to this workspace. */
  scopedServerId: string | null;
  scopedWorkspaceId: string | null;
}

export interface SharedParticipant {
  sessionId: string;
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
          sessionToken: data.sessionToken ?? null,
          accessLevel: data.accessLevel ?? null,
          currentUser: data.currentUser ?? null,
          ownerName: data.ownerName ?? null,
          enteredViaShare: data.enteredViaShare ?? false,
          scopedServerId: data.scopedServerId ?? null,
          scopedWorkspaceId: data.scopedWorkspaceId ?? null,
        };
      }
    }
  } catch {
    /* ignore */
  }
  return {};
}

const persisted = loadPersistedState();

let state: SharedSessionState = {
  room: null,
  shareToken: persisted.shareToken ?? null,
  sessionToken: persisted.sessionToken ?? null,
  accessLevel: persisted.accessLevel ?? null,
  currentUser: persisted.currentUser ?? null,
  ownerName: persisted.ownerName ?? null,
  participants: new Map(),
  enteredViaShare: persisted.enteredViaShare ?? false,
  sessionEnded: false,
  scopedServerId: persisted.scopedServerId ?? null,
  scopedWorkspaceId: persisted.scopedWorkspaceId ?? null,
};

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Prime the share scope BEFORE opening the relay connection. The hello message
 * that the DaemonClient sends must carry the share token so the daemon attaches
 * the workspace scope to the session. Without this, the initial connection
 * would look like an owner-privileged session until a reconnect re-sends hello.
 */
export function primeShareScope(params: {
  shareToken: string;
  sessionToken: string;
  accessLevel: string;
  currentUser: SharedSessionUser | null;
  ownerName: string | null;
  scope: { serverId: string; workspaceId: string };
}) {
  state = {
    ...state,
    shareToken: params.shareToken,
    sessionToken: params.sessionToken,
    accessLevel: params.accessLevel,
    currentUser: params.currentUser,
    ownerName: params.ownerName,
    enteredViaShare: true,
    sessionEnded: false,
    scopedServerId: params.scope.serverId,
    scopedWorkspaceId: params.scope.workspaceId,
  };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(
        "hubcode_shared_session",
        JSON.stringify({
          shareToken: params.shareToken,
          sessionToken: params.sessionToken,
          accessLevel: params.accessLevel,
          currentUser: params.currentUser,
          ownerName: params.ownerName,
          enteredViaShare: true,
          scopedServerId: params.scope.serverId,
          scopedWorkspaceId: params.scope.workspaceId,
        }),
      );
    }
  } catch {
    /* ignore */
  }
  emit();
}

export function setSharedSession(
  room: any,
  shareToken: string,
  accessLevel: string,
  currentUser?: SharedSessionUser | null,
  ownerName?: string | null,
  sessionToken?: string | null,
  scope?: { serverId: string; workspaceId: string } | null,
) {
  console.log(
    "[shared-session] setSharedSession called, room:",
    !!room,
    "token:",
    shareToken,
    "user:",
    currentUser?.username,
  );
  const nextScopedServerId = scope?.serverId ?? state.scopedServerId ?? null;
  const nextScopedWorkspaceId = scope?.workspaceId ?? state.scopedWorkspaceId ?? null;
  // If we're being handed the SAME room instance, don't touch anything extra.
  // If the existing room is different, prefer keeping it alive — calling leave
  // here was causing a dispose cascade when strict-mode double-invoked
  // setSharedSession. The server's dedupe-by-userId handles duplicates.
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
    scopedServerId: nextScopedServerId,
    scopedWorkspaceId: nextScopedWorkspaceId,
  };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(
        "hubcode_shared_session",
        JSON.stringify({
          shareToken,
          sessionToken: sessionToken ?? state.sessionToken,
          accessLevel,
          currentUser,
          ownerName,
          enteredViaShare: true,
          scopedServerId: nextScopedServerId,
          scopedWorkspaceId: nextScopedWorkspaceId,
        }),
      );
    }
  } catch {
    /* ignore */
  }
  emit();
  wireParticipantSync(room);
  wireSessionExpiredListener(room);
}

function wireSessionExpiredListener(room: any) {
  try {
    room?.onMessage?.("session_expired", (payload: { reason?: string }) => {
      console.warn("[shared-session] session_expired from server:", payload?.reason);
      void endSharedSessionAndDisconnect();
    });
  } catch (err) {
    console.warn("[shared-session] failed to wire session_expired:", err);
  }
}

/**
 * Subscribe to participant state changes on a Colyseus room. The MapSchema API
 * in @colyseus/schema 2.x requires `triggerAll=true` on onAdd to fire for
 * entries that already exist at subscription time. Without that flag,
 * participants added BEFORE the local client joins are invisible — which is
 * the exact scenario when joining a room that already has the owner in it.
 */
function wireParticipantSync(room: any) {
  let attached = false;
  let pollHandle: ReturnType<typeof setInterval> | null = null;
  // When the custom `participants_list` channel succeeds, its data is more
  // reliable than the schema state sync (which has been flaky in this combo
  // of @colyseus/schema 2.x versions). Once we've received a custom-message
  // snapshot, stop the schema poll so it doesn't overwrite good data with
  // an empty list.
  let customSnapshotReceived = false;

  function inspectState() {
    const rs = room?.state;
    if (!rs) return "no room.state";
    const keys = Object.keys(rs);
    const pKind = rs.participants
      ? `exists, keys=${Object.keys(rs.participants).slice(0, 5).join(",")}, size=${rs.participants.size ?? "?"}, $items=${rs.participants.$items ? "yes" : "no"}`
      : "undefined";
    return `state keys=[${keys.join(",")}] participants=${pKind}`;
  }

  function refresh() {
    // If the custom-message channel already populated state, skip the schema
    // poll — it reads an empty MapSchema and would clobber the good data.
    if (customSnapshotReceived) return;
    const mapLike = room?.state?.participants;
    if (!mapLike) {
      console.log("[shared-session] refresh — participants map missing;", inspectState());
      return;
    }
    const next = new Map<string, SharedParticipant>();
    const addEntry = (p: any, key: string) => {
      if (!p) return;
      next.set(key, {
        sessionId: key,
        userId: p.userId ?? key,
        username: p.username ?? "",
        avatarUrl: p.avatarUrl ?? "",
        role: p.role ?? "viewer",
        audioEnabled: p.audioEnabled ?? false,
        isOnline: p.isOnline ?? true,
      });
    };
    let iterationPath = "none";
    try {
      if (mapLike.$items && typeof mapLike.$items.forEach === "function") {
        // Internal MapSchema Map — most reliable in schema 2.x.
        mapLike.$items.forEach((p: any, key: string) => addEntry(p, key));
        iterationPath = "$items";
      } else if (typeof mapLike.forEach === "function") {
        mapLike.forEach((p: any, key: string) => addEntry(p, key));
        iterationPath = "forEach";
      } else if (mapLike[Symbol.iterator]) {
        for (const [key, p] of mapLike as Iterable<[string, any]>) addEntry(p, key);
        iterationPath = "iterator";
      }
    } catch (err) {
      console.warn("[shared-session] iteration failed:", err);
    }
    state = { ...state, participants: next };
    emit();
    console.log(
      `[shared-session] participants sync size=${next.size} via=${iterationPath} keys=${JSON.stringify(Array.from(next.keys()))}; ${inspectState()}`,
    );
  }

  function attachParticipantListeners() {
    if (attached) return true;
    const mapLike = room?.state?.participants;
    if (!mapLike || typeof mapLike.onAdd !== "function") {
      return false;
    }
    try {
      mapLike.onAdd((p: any, key: string) => {
        console.log("[shared-session] onAdd participant:", key, p?.username);
        p?.onChange?.(() => refresh());
        refresh();
      }, true);
      mapLike.onChange?.((_: any, key: string) => {
        console.log("[shared-session] onChange participant:", key);
        refresh();
      });
      mapLike.onRemove?.((_: any, key: string) => {
        console.log("[shared-session] onRemove participant:", key);
        refresh();
      });
      attached = true;
      refresh();
      return true;
    } catch (err) {
      console.warn("[shared-session] failed to attach MapSchema listeners:", err);
      return false;
    }
  }

  try {
    console.log("[shared-session] wireParticipantSync start;", inspectState());
    if (!attachParticipantListeners()) {
      console.log("[shared-session] participants state not yet synced; waiting");
    }
    room?.onStateChange?.((_s: unknown) => {
      if (!attached) attachParticipantListeners();
      refresh();
    });
    // Primary channel: custom 'participants_list' broadcast from the server.
    // This bypasses any MapSchema sync issues and guarantees the UI shows peers.
    room?.onMessage?.("participants_list", (payload: any) => {
      const rawList = Array.isArray(payload?.participants) ? payload.participants : [];
      const next = new Map<string, SharedParticipant>();
      for (const p of rawList) {
        if (!p || typeof p.sessionId !== "string") continue;
        next.set(p.sessionId, {
          sessionId: String(p.sessionId),
          userId: String(p.userId ?? ""),
          username: String(p.username ?? ""),
          avatarUrl: String(p.avatarUrl ?? ""),
          role: String(p.role ?? "viewer"),
          audioEnabled: Boolean(p.audioEnabled),
          isOnline: Boolean(p.isOnline ?? true),
        });
      }
      customSnapshotReceived = true;
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      state = { ...state, participants: next };
      emit();
      console.log(
        "[shared-session] participants_list received — count:",
        next.size,
        Array.from(next.values()).map((p) => p.username),
      );
    });
    room?.onMessage?.("*", (type: any, message: any) => {
      console.log("[shared-session] room message received:", type, message);
    });
    // Poll fallback: if after 2s still no listeners attached or empty,
    // iterate and refresh. Colyseus state patches sometimes don't fire
    // onStateChange on deep nested mutations in certain schema versions.
    pollHandle = setInterval(() => {
      if (!room || !room.state) return;
      if (!attached) attachParticipantListeners();
      refresh();
    }, 1000);
    room?.onLeave?.(() => {
      if (pollHandle) {
        clearInterval(pollHandle);
        pollHandle = null;
      }
      // When the owner ends the share (room disposed server-side) we must
      // also kick the recipient out of the scoped workspace — otherwise they
      // keep viewing the host even though the session is gone. Mirror the
      // logic from the explicit "Sair" button.
      void endSharedSessionAndDisconnect();
    });
  } catch (err) {
    console.warn("[shared-session] wireParticipantSync failed:", err);
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
    scopedServerId: null,
    scopedWorkspaceId: null,
  };
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.removeItem("hubcode_shared_session");
    }
  } catch {
    /* ignore */
  }
  emit();
}

export function getSharedSessionSnapshot(): SharedSessionState {
  return state;
}

// Full teardown used when the share ends (owner revokes, Colyseus room
// disposes, or recipient clicks Sair): drops the relay-scoped host, clears
// the session state, and navigates home. Kept async so callers can await if
// they want to guarantee the host is gone before navigating.
export async function endSharedSessionAndDisconnect(): Promise<void> {
  const scopedServerId = state.scopedServerId;
  clearSharedSession();
  if (scopedServerId) {
    try {
      const { getHostRuntimeStore } = await import("@/runtime/host-runtime");
      await getHostRuntimeStore().removeHost(scopedServerId);
    } catch {
      // ignore — host may already be gone
    }
  }
  try {
    const { router } = await import("expo-router");
    router.replace("/");
  } catch {
    // ignore — navigation best-effort
  }
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

/**
 * True when the current user joined via a share link AND the share grants only
 * view-only access. Used to render read-only UI (disable input, hide write
 * actions). Returns false for owners and for "full_access" recipients.
 */
export function useIsSharedViewOnly(): boolean {
  const { enteredViaShare, accessLevel } = useSharedSessionStore();
  return enteredViaShare && accessLevel === "read_only";
}

export function useSharedParticipants(): Map<string, SharedParticipant> {
  const { participants } = useSharedSessionStore();
  return participants;
}

export function useSharedWorkspaceScope(): {
  serverId: string | null;
  workspaceId: string | null;
} {
  const { scopedServerId, scopedWorkspaceId, enteredViaShare } = useSharedSessionStore();
  if (!enteredViaShare) return { serverId: null, workspaceId: null };
  return { serverId: scopedServerId, workspaceId: scopedWorkspaceId };
}

/**
 * Snapshot accessor used by host-runtime when creating a DaemonClient. When the
 * current session entered via a workspace-share link, the share credentials are
 * attached to the hello handshake so the daemon can enforce workspace scope.
 */
export function resolveShareAuthForServerId(
  serverId: string,
): { shareToken: string; shareSessionToken: string; authServerUrl?: string } | null {
  if (!state.enteredViaShare || !state.shareToken || !state.sessionToken) return null;
  // Only attach share credentials when the connection target matches the
  // scoped host — prevents leaking a share token to unrelated daemons.
  if (state.scopedServerId && state.scopedServerId !== serverId) return null;
  const authServerUrl =
    typeof __DEV__ !== "undefined" && __DEV__ ? "http://localhost:3002" : "https://auth.hubcode.ai";
  return {
    shareToken: state.shareToken,
    shareSessionToken: state.sessionToken,
    authServerUrl,
  };
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
    // Guard against a race: if some other code path set state.room while
    // we were awaiting join, drop the new one to avoid a ghost session.
    if (state.room && state.room !== room) {
      try {
        room.leave?.();
      } catch {
        /* ignore */
      }
      return;
    }
    state = { ...state, room };
    emit();
    console.log("[shared-session] auto-reconnected to Colyseus room");
    wireParticipantSync(room);
    wireSessionExpiredListener(room);
  } catch (err) {
    // Reconnect failed — most commonly because the share was revoked or the
    // room was disposed server-side. Tear down the scoped host connection
    // and navigate home so the user can't keep interacting via the /h/ URL.
    console.warn("[shared-session] auto-reconnect failed:", err);
    void endSharedSessionAndDisconnect();
  } finally {
    reconnecting = false;
  }
}
