/**
 * Global store for shared session state.
 * When a user joins a shared session via Colyseus, the room reference
 * is stored here so the agent panel and other components can react.
 */

import { useSyncExternalStore } from "react";
import { clearChatAuthors, pushChatAuthor } from "@/stores/shared-chat-authors-store";
import {
  clearAllTyping,
  notifyLocalTyping,
  setRemoteTyping,
  stopLocalTyping,
} from "@/stores/shared-typing-store";
import { clearSessionChat, wireSessionChatListeners } from "@/stores/session-chat-store";

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
  /**
   * True when the CURRENT user is the host/owner of the share (opened the
   * session from their own "Shared by you" row). Host mode keeps the user on
   * their local daemon — no relay, no scoped sidebar — but still joins the
   * Colyseus room so they see participant chips + the video panel.
   */
  hostMode: boolean;
  /** Recipient-only scope: when set, sidebar is restricted to this workspace. */
  scopedServerId: string | null;
  scopedWorkspaceId: string | null;
  /**
   * True while we're in the middle of joining a shared session (Colyseus room
   * connection in flight). Drives a full-screen loading overlay so the UI
   * doesn't flash workspace chrome + progressively-appearing video/sidebar
   * layers as each piece finishes.
   */
  joining: boolean;
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

/**
 * Pure-web F5 guard: if we have persisted share credentials but no live room
 * (in-memory only, never persisted), the recipient is reloading mid-session.
 * Do a synchronous redirect to the auth-server pre-join page BEFORE any React
 * mounts — otherwise the daemon UI flashes with stale credentials and the
 * recipient could briefly interact with the workspace before being bounced.
 *
 * Electron keeps the silent auto-reconnect path (enteredViaShare stays true
 * and we rejoin Colyseus in GlobalSharedSessionBar).
 */
(function guardStaleSharedSessionOnWebReload() {
  try {
    if (typeof window === "undefined") return;
    if (typeof sessionStorage === "undefined") return;
    // Detect Electron without importing getIsElectron (this runs at module
    // load, before platform utils are safe to call).
    const isElectron =
      typeof (window as any).process?.type === "string" ||
      Boolean((window as any).electron) ||
      Boolean((window as any).desktop);
    if (isElectron) return;
    if (!persisted.enteredViaShare || !persisted.shareToken) return;
    // Already on the pre-join or auth flow? Nothing to do.
    const path = window.location.pathname || "";
    if (path.startsWith("/join-workspace/")) return;
    sessionStorage.removeItem("hubcode_shared_session");
    const authServerUrl =
      typeof __DEV__ !== "undefined" && __DEV__
        ? "http://localhost:3002"
        : "https://auth.hubcode.ai";
    window.location.replace(`${authServerUrl}/join-workspace/${persisted.shareToken}`);
  } catch {
    /* ignore */
  }
})();

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
  hostMode: false,
  scopedServerId: persisted.scopedServerId ?? null,
  scopedWorkspaceId: persisted.scopedWorkspaceId ?? null,
  joining: false,
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
  wireChatMessageListener(room);
  wireTypingStatusListener(room);
  wireSessionChatListeners(room);
}

function wireTypingStatusListener(room: any) {
  try {
    room?.onMessage?.(
      "typing_status",
      (payload: { userId?: string; username?: string; avatarUrl?: string; typing?: boolean }) => {
        const userId = String(payload?.userId ?? "");
        if (!userId) return;
        setRemoteTyping(
          {
            userId,
            username: String(payload.username ?? ""),
            avatarUrl: String(payload.avatarUrl ?? ""),
          },
          Boolean(payload.typing),
        );
      },
    );
  } catch (err) {
    console.warn("[shared-session] failed to wire typing_status:", err);
  }
}

/**
 * Snapshot of the current shared-session user suitable for stamping onto an
 * outbound agent message. Returns null outside of a shared session — in that
 * case the daemon stream never carries author metadata and the UI falls back
 * to a generic user bubble.
 */
export function getSharedSessionAuthor(): {
  userId: string;
  username: string;
  avatarUrl: string;
} | null {
  if (!state.enteredViaShare) return null;
  const user = state.currentUser;
  if (!user) return null;
  return {
    userId: user.userId,
    username: user.username,
    avatarUrl: user.avatarUrl,
  };
}

/**
 * Called from the agent-input send path so every client (including the sender)
 * labels the resulting user_message bubble with the author's name + avatar.
 * Currently agent messages bypass the Colyseus chat queue — this closes the
 * attribution gap without re-routing the daemon send path.
 */
/**
 * Broadcast that the local user is typing. Safe to call on every keystroke —
 * the typing store debounces the outgoing `typing_start`/`typing_stop`.
 */
export function notifyLocalUserTyping(): void {
  if (!state.enteredViaShare) return;
  if (!state.room) return;
  notifyLocalTyping(state.room);
}

export function notifyLocalUserStoppedTyping(): void {
  if (!state.room) return;
  stopLocalTyping(state.room);
}

export function notifyChatMessageAuthored(content: string): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  if (!state.enteredViaShare) return;
  const user = state.currentUser;
  if (!user) return;
  // Locally buffer so my own bubble shows my name too (the broadcast below
  // reaches other participants; this entry covers me).
  pushChatAuthor({
    userId: user.userId,
    username: user.username,
    avatarUrl: user.avatarUrl,
    content: trimmed,
    ts: Date.now(),
  });
  try {
    state.room?.send?.("chat_authored", { content: trimmed });
  } catch (err) {
    console.warn("[shared-session] failed to send chat_authored:", err);
  }
}

function wireChatMessageListener(room: any) {
  try {
    room?.onMessage?.(
      "chat_message",
      (payload: {
        userId?: string;
        username?: string;
        avatarUrl?: string;
        content?: string;
        ts?: number;
      }) => {
        if (!payload?.content) return;
        pushChatAuthor({
          userId: String(payload.userId ?? ""),
          username: String(payload.username ?? ""),
          avatarUrl: String(payload.avatarUrl ?? ""),
          content: String(payload.content).trim(),
          ts: typeof payload.ts === "number" ? payload.ts : Date.now(),
        });
      },
    );
  } catch (err) {
    console.warn("[shared-session] failed to wire chat_message:", err);
  }
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
      // Skip if a newer room has already replaced this one — late callbacks
      // from a torn-down room must not nuke the fresh session.
      if (state.room && state.room !== room) return;
      void endSharedSessionAndDisconnect();
    });
  } catch (err) {
    console.warn("[shared-session] wireParticipantSync failed:", err);
  }
}

/**
 * Join the Colyseus room as the host of a share the current user owns —
 * activates the participant bar + floating video panel so the host can watch
 * invitees join, but keeps them on their local daemon (no relay connection,
 * no scoped sidebar). Call after navigating to the workspace that's being
 * shared so the room stays tied to that tab.
 */
export async function startSharedSessionAsHost(params: {
  shareToken: string;
  sessionToken: string;
  currentUser: SharedSessionUser;
  ownerName: string | null;
  accessLevel: string;
}): Promise<void> {
  // Short-circuit: already in this share as host.
  if (state.hostMode && state.shareToken === params.shareToken && state.room) return;
  // Tear down any stale recipient session first — we never want both modes.
  if (state.enteredViaShare && !state.hostMode) {
    await endSharedSessionAndDisconnect();
  }
  state = { ...state, joining: true };
  emit();
  try {
    const { joinSharedSession } = await import("@/hooks/sharing/colyseus-client");
    const room = await joinSharedSession({
      shareToken: params.shareToken,
      sessionToken: params.sessionToken,
    });
    state = {
      ...state,
      room,
      shareToken: params.shareToken,
      sessionToken: params.sessionToken,
      accessLevel: params.accessLevel,
      currentUser: params.currentUser,
      ownerName: params.ownerName,
      enteredViaShare: true,
      sessionEnded: false,
      hostMode: true,
      // Host keeps local daemon — no scope.
      scopedServerId: null,
      scopedWorkspaceId: null,
      joining: false,
    };
    emit();
    wireParticipantSync(room);
    wireSessionExpiredListener(room);
    wireChatMessageListener(room);
    wireTypingStatusListener(room);
    wireSessionChatListeners(room);
  } catch (err) {
    console.warn("[shared-session] host-mode join failed:", err);
    state = { ...state, joining: false };
    emit();
  }
}

export function clearSharedSession(): void {
  clearSharedSessionWithReason({ wasHostMode: state.hostMode });
}

function clearSharedSessionWithReason(opts: { wasHostMode: boolean }): void {
  if (state.room) {
    try {
      state.room.leave?.();
    } catch {
      // Ignore
    }
  }
  clearChatAuthors();
  clearAllTyping();
  clearSessionChat();
  state = {
    room: null,
    shareToken: null,
    sessionToken: null,
    accessLevel: null,
    currentUser: null,
    ownerName: null,
    participants: new Map(),
    enteredViaShare: false,
    // `sessionEnded` triggers the recipient-eviction redirect in
    // SharedWorkspaceRouteGuard. When the host leaves their own share, there's
    // nothing to evict — the host stays on their local daemon — so keep the
    // flag false to avoid a redirect loop with the index route.
    sessionEnded: !opts.wasHostMode,
    hostMode: false,
    scopedServerId: null,
    scopedWorkspaceId: null,
    joining: false,
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

/**
 * Flip `sessionEnded` back to false after a guard has consumed it. The flag is
 * a one-shot signal meant to trigger a single eviction redirect; keeping it
 * true indefinitely would cause every subsequent navigation to a workspace
 * route to bounce to `/` in an infinite loop.
 */
export function acknowledgeSessionEnded(): void {
  if (!state.sessionEnded) return;
  state = { ...state, sessionEnded: false };
  emit();
}

// Full teardown used when the share ends (owner revokes, Colyseus room
// disposes, or recipient clicks Sair): drops the relay-scoped host, clears
// the session state, and navigates home. Kept async so callers can await if
// they want to guarantee the host is gone before navigating.
export async function endSharedSessionAndDisconnect(): Promise<void> {
  const scopedServerId = state.scopedServerId;
  const wasHostMode = state.hostMode;
  const shareToken = state.shareToken;
  clearSharedSession();
  if (scopedServerId) {
    try {
      const { getHostRuntimeStore } = await import("@/runtime/host-runtime");
      await getHostRuntimeStore().removeHost(scopedServerId);
    } catch {
      // ignore — host may already be gone
    }
  }
  // Host mode never scoped the daemon or navigated in, so we don't navigate
  // out either — the user stays on whatever workspace they were viewing.
  if (wasHostMode) return;
  // Recipients: bounce back to the auth-server pre-join page for the share
  // they just left, so rejoining is one click away. If we somehow don't have
  // the share token, fall back to home.
  if (shareToken && typeof window !== "undefined") {
    const authServerUrl =
      typeof __DEV__ !== "undefined" && __DEV__
        ? "http://localhost:3002"
        : "https://auth.hubcode.ai";
    window.location.replace(`${authServerUrl}/join-workspace/${shareToken}`);
    return;
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

export function useIsJoiningSharedSession(): boolean {
  const { joining } = useSharedSessionStore();
  return joining;
}

/**
 * True only when the user joined as a *recipient* (not the host). Used by UI
 * pieces that should only apply to recipients — hidden org rail, scoped
 * sidebar, etc. Returns false when the host is in "host mode" (peeking at
 * their own share without leaving their local daemon).
 */
export function useIsSharedRecipient(): boolean {
  const { enteredViaShare, hostMode } = useSharedSessionStore();
  return enteredViaShare && !hostMode;
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
  const shareTokenSnapshot = state.shareToken;
  state = { ...state, joining: true };
  emit();
  try {
    const { joinSharedSession } = await import("@/hooks/sharing/colyseus-client");
    const room = await joinSharedSession({
      shareToken: shareTokenSnapshot,
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
    state = { ...state, room, joining: false };
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
    if (state.joining) {
      state = { ...state, joining: false };
      emit();
    }
  }
}
