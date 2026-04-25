import { useEffect, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { joinOrgChat, type ColyseusRoom } from "@/hooks/sharing/colyseus-client";
import type { ChatAttachment, ChatMessage } from "@/api/chat";
import { useChatStore } from "@/stores/chat-store";
import { bumpChannelUnread, chatKeys } from "@/hooks/chat/use-chat-queries";
import { extractMentionUserIdsClient } from "@/lib/chat-mentions";

export type OrgChatConnectionState = "idle" | "connecting" | "connected" | "error";

export interface UseOrgChatRoomResult {
  state: OrgChatConnectionState;
  error: Error | null;
  room: ColyseusRoom | null;
  send: (payload: {
    channelId: string;
    content: string;
    parentId?: string | null;
    quotedMessageId?: string | null;
    attachments?: ChatAttachment[];
  }) => void;
  edit: (payload: { messageId: string; content: string }) => void;
  remove: (payload: { messageId: string }) => void;
  reactAdd: (payload: { messageId: string; emoji: string }) => void;
  reactRemove: (payload: { messageId: string; emoji: string }) => void;
  typing: (channelId: string, parentId?: string | null) => void;
  setStatus: (status: "active" | "busy" | "offline") => void;
}

// ---- Module-level singleton ------------------------------------------------
// One connection per (orgId, sessionToken) pair, regardless of how many
// components call `useOrgChatRoom`. Refcount tracks active subscribers; when
// it drops to zero we leave the room. Any mount from any component shares the
// same room reference, so there's no "Wrong protocol" churn from disposing a
// room that another caller still expects.

type Connection = {
  key: string;
  orgId: string;
  sessionToken: string;
  currentUserId: string | null;
  qc: QueryClient | null;
  refs: number;
  state: OrgChatConnectionState;
  error: Error | null;
  room: ColyseusRoom | null;
  // Set during `connecting` so a late cleanup can cancel.
  disposed: boolean;
};

let connection: Connection | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return connection;
}

function setConnState(patch: Partial<Connection>) {
  if (!connection) return;
  Object.assign(connection, patch);
  emit();
}

async function openConnection(
  orgId: string,
  sessionToken: string,
  currentUserId: string | null,
  qc: QueryClient,
) {
  const key = `${orgId}|${sessionToken}`;
  if (connection && connection.key === key) {
    connection.refs += 1;
    // Keep the latest caller's context (currentUserId/qc) so events route
    // against the right identity even if the initial owner unmounts.
    connection.currentUserId = currentUserId;
    connection.qc = qc;
    emit();
    return;
  }
  // A different (orgId, sessionToken) — tear down old and start fresh.
  if (connection) {
    closeConnectionNow();
  }
  const entry: Connection = {
    key,
    orgId,
    sessionToken,
    currentUserId,
    qc,
    refs: 1,
    state: "connecting",
    error: null,
    room: null,
    disposed: false,
  };
  connection = entry;
  emit();
  try {
    const room = await joinOrgChat({ orgId, sessionToken });
    if (entry.disposed) {
      try {
        room.leave();
      } catch {
        // ignore
      }
      return;
    }
    entry.room = room;
    wireRoomEvents(entry, room);
    entry.state = "connected";
    room.onLeave(() => {
      if (connection === entry && !entry.disposed) {
        entry.state = "idle";
        emit();
      }
    });
    emit();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Stale activeOrgId — user was kicked, the org was deleted, or they
    // signed in to a different account. Clear the pin so the next render
    // uses organizations[0] (Personal is guaranteed to exist post-signup)
    // and stop logging the error as if it were unexpected.
    if (message.toLowerCase().includes("not a member")) {
      console.info("[org-chat] join refused (stale activeOrgId) — clearing");
      const { setActiveOrgId } = await import("@/stores/active-org-store");
      setActiveOrgId(null);
    } else {
      console.error("[org-chat] join failed", err);
    }
    if (!entry.disposed) {
      entry.error = err instanceof Error ? err : new Error(String(err));
      entry.state = "error";
      emit();
    }
  }
}

function closeConnectionNow() {
  const entry = connection;
  if (!entry) return;
  entry.disposed = true;
  const room = entry.room;
  entry.room = null;
  connection = null;
  emit();
  if (room) {
    try {
      room.leave();
    } catch {
      // ignore
    }
  }
}

function releaseConnection(key: string) {
  if (!connection || connection.key !== key) return;
  connection.refs -= 1;
  if (connection.refs > 0) return;
  closeConnectionNow();
}

// ---- Hook ------------------------------------------------------------------

/**
 * Subscribe to an org's realtime chat room. Every call shares a single WS
 * connection per (orgId, sessionToken) pair via a module-level singleton, so
 * mounting the hook from multiple components (global presence mount + chat
 * screen) doesn't open extra sockets.
 */
export function useOrgChatRoom(
  orgId: string | null,
  sessionToken: string | null,
  currentUserId: string | null = null,
): UseOrgChatRoomResult {
  const qc = useQueryClient();
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    // Web uses cookie auth → sessionToken is intentionally "". Treat `null`
    // as "not authenticated yet" and anything else (including empty string)
    // as authenticated.
    if (!orgId || sessionToken === null) return;
    const key = `${orgId}|${sessionToken}`;
    void openConnection(orgId, sessionToken, currentUserId, qc);
    return () => {
      releaseConnection(key);
    };
  }, [orgId, sessionToken, qc, currentUserId]);

  // Periodic cleanup for stale typing indicators. Runs once per mount; cheap.
  useEffect(() => {
    const timer = setInterval(() => {
      useChatStore.getState().clearStaleTyping();
    }, 2_000);
    return () => clearInterval(timer);
  }, []);

  // Broadcast my status whenever it changes (or on (re)connect). Keyed to the
  // connection's state so we re-send on reconnects.
  const connState = snapshot?.state ?? "idle";
  useEffect(() => {
    if (connState !== "connected") return;
    const broadcast = () => {
      const s = useChatStore.getState().myStatus;
      connection?.room?.send("presence_status", { status: s });
    };
    broadcast();
    const unsubscribe = useChatStore.subscribe(
      (s) => s.myStatus,
      () => broadcast(),
    );
    return () => unsubscribe();
  }, [connState]);

  const match =
    snapshot && snapshot.orgId === orgId && snapshot.sessionToken === sessionToken
      ? snapshot
      : null;

  const send: UseOrgChatRoomResult["send"] = (payload) => {
    match?.room?.send("send", payload);
  };
  const edit: UseOrgChatRoomResult["edit"] = (payload) => {
    match?.room?.send("edit", payload);
  };
  const remove: UseOrgChatRoomResult["remove"] = (payload) => {
    match?.room?.send("delete", payload);
  };
  const reactAdd: UseOrgChatRoomResult["reactAdd"] = (payload) => {
    match?.room?.send("react_add", payload);
  };
  const reactRemove: UseOrgChatRoomResult["reactRemove"] = (payload) => {
    match?.room?.send("react_remove", payload);
  };
  const typing: UseOrgChatRoomResult["typing"] = (channelId, parentId = null) => {
    match?.room?.send("typing", { channelId, parentId });
  };
  const setStatus: UseOrgChatRoomResult["setStatus"] = (status) => {
    match?.room?.send("presence_status", { status });
  };

  return {
    state: match?.state ?? "idle",
    error: match?.error ?? null,
    room: match?.room ?? null,
    send,
    edit,
    remove,
    reactAdd,
    reactRemove,
    typing,
    setStatus,
  };
}

function wireRoomEvents(entry: Connection, room: ColyseusRoom) {
  const orgId = entry.orgId;
  const store = useChatStore.getState();

  room.onMessage("message", (payload: { message: ChatMessage }) => {
    const msg = payload?.message;
    if (!msg) return;
    // Dedupe an optimistic local placeholder if this real broadcast matches it
    // (same author + channel + content + same parent). Placeholders use an id
    // prefixed with "tmp_" so we can find them without tracking extra state.
    const latest = useChatStore.getState().messagesByChannel[msg.channelId] ?? [];
    const localMatch = latest.find(
      (m) =>
        m.id.startsWith("tmp_") &&
        m.userId === msg.userId &&
        (m.parentId ?? null) === (msg.parentId ?? null) &&
        m.content === msg.content,
    );
    if (localMatch) store.dropMessage(localMatch.id);
    store.upsertMessage(msg);
    // A posted message supersedes any typing indicator from the same author.
    store.clearTypingForUser(msg.channelId, msg.userId);

    const self = entry.currentUserId;
    if (self && msg.userId === self) return;
    const active = useChatStore.getState().activeChannelId;
    if (active === msg.channelId) return;
    const mentioned = self !== null && extractMentionUserIdsClient(msg.content).includes(self);
    if (entry.qc) {
      bumpChannelUnread(entry.qc, {
        orgId,
        channelId: msg.channelId,
        mentioned,
      });
      if (mentioned) {
        entry.qc.invalidateQueries({ queryKey: chatKeys.myMentions(orgId) });
      }
    }
  });
  room.onMessage("message_edited", (payload: { message: ChatMessage }) => {
    if (payload?.message) store.updateMessage(payload.message);
  });
  room.onMessage("message_deleted", (payload: { messageId: string }) => {
    if (payload?.messageId) store.removeMessage(payload.messageId);
  });
  room.onMessage(
    "reaction_added",
    (payload: { messageId: string; userId: string; emoji: string }) => {
      store.applyReaction("add", payload);
    },
  );
  room.onMessage(
    "reaction_removed",
    (payload: { messageId: string; userId: string; emoji: string }) => {
      store.applyReaction("remove", payload);
    },
  );
  room.onMessage(
    "typing",
    (payload: {
      channelId: string;
      parentId?: string | null;
      userId: string;
      username: string;
      at: number;
    }) => {
      if (!payload?.channelId) return;
      store.setTyping(payload.channelId, {
        userId: payload.userId,
        username: payload.username,
        at: payload.at ?? Date.now(),
        parentId: payload.parentId ?? null,
      });
    },
  );
  room.onMessage("error", (payload: { code?: string; error?: string }) => {
    console.warn("[org-chat] server error", payload);
  });

  // Primary presence channel — server broadcasts the full online list on any
  // change (join/leave/status). Reliable across schema versions.
  room.onMessage(
    "presence_list",
    (payload: {
      participants: Array<{
        userId: string;
        username: string;
        avatarUrl: string;
        since: number;
        status?: string;
      }>;
    }) => {
      const list = (payload?.participants ?? []).map((p) => {
        const status: "active" | "busy" | "offline" =
          p.status === "active" || p.status === "busy" || p.status === "offline"
            ? p.status
            : "active";
        return {
          userId: p.userId,
          username: p.username,
          avatarUrl: p.avatarUrl,
          since: p.since,
          status,
        };
      });
      useChatStore.getState().replacePresence(orgId, list);
    },
  );

  // Best-effort fallback via state sync; nested MapSchema onStateChange is
  // unreliable in this @colyseus/schema version, so we treat `presence_list`
  // as primary.
  const syncPresence = () => {
    const online = room.state?.online;
    if (!online) return;
    const list: {
      userId: string;
      username: string;
      avatarUrl: string;
      since: number;
      status?: "active" | "busy" | "offline";
    }[] = [];
    online.forEach(
      (p: {
        userId: string;
        username: string;
        avatarUrl: string;
        since: number;
        status?: string;
      }) => {
        const status =
          p.status === "active" || p.status === "busy" || p.status === "offline"
            ? p.status
            : "active";
        list.push({
          userId: p.userId,
          username: p.username,
          avatarUrl: p.avatarUrl,
          since: p.since,
          status,
        });
      },
    );
    useChatStore.getState().replacePresence(orgId, list);
  };

  try {
    room.onStateChange(() => syncPresence());
    syncPresence();
  } catch {
    // older colyseus clients may not support onStateChange in this shape; ignore.
  }
}
