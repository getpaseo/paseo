import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
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
    attachments?: ChatAttachment[];
  }) => void;
  edit: (payload: { messageId: string; content: string }) => void;
  remove: (payload: { messageId: string }) => void;
  reactAdd: (payload: { messageId: string; emoji: string }) => void;
  reactRemove: (payload: { messageId: string; emoji: string }) => void;
  typing: (channelId: string, parentId?: string | null) => void;
}

/**
 * Subscribe to an org's realtime chat room. Maintains a single WS connection
 * per (orgId, sessionToken) pair and wires server events straight into the
 * global chat store, so every component that consumes the store sees updates.
 */
export function useOrgChatRoom(
  orgId: string | null,
  sessionToken: string | null,
  currentUserId: string | null = null,
): UseOrgChatRoomResult {
  const [state, setState] = useState<OrgChatConnectionState>("idle");
  const [error, setError] = useState<Error | null>(null);
  const roomRef = useRef<ColyseusRoom | null>(null);
  const qc = useQueryClient();

  useEffect(() => {
    if (!orgId || !sessionToken) {
      setState("idle");
      return;
    }
    let disposed = false;
    setState("connecting");
    setError(null);

    (async () => {
      try {
        const room = await joinOrgChat({ orgId, sessionToken });
        if (disposed) {
          try {
            room.leave();
          } catch {
            // ignore
          }
          return;
        }
        roomRef.current = room;
        wireRoomEvents(orgId, room, {
          qc,
          currentUserId,
        });
        setState("connected");
        room.onLeave(() => {
          if (!disposed) setState("idle");
        });
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setState("error");
        }
      }
    })();

    return () => {
      disposed = true;
      const current = roomRef.current;
      roomRef.current = null;
      if (current) {
        try {
          current.leave();
        } catch {
          // ignore
        }
      }
    };
  }, [orgId, sessionToken, qc, currentUserId]);

  // Periodic cleanup for stale typing indicators.
  useEffect(() => {
    const timer = setInterval(() => {
      useChatStore.getState().clearStaleTyping();
    }, 2_000);
    return () => clearInterval(timer);
  }, []);

  const send: UseOrgChatRoomResult["send"] = (payload) => {
    roomRef.current?.send("send", payload);
  };
  const edit: UseOrgChatRoomResult["edit"] = (payload) => {
    roomRef.current?.send("edit", payload);
  };
  const remove: UseOrgChatRoomResult["remove"] = (payload) => {
    roomRef.current?.send("delete", payload);
  };
  const reactAdd: UseOrgChatRoomResult["reactAdd"] = (payload) => {
    roomRef.current?.send("react_add", payload);
  };
  const reactRemove: UseOrgChatRoomResult["reactRemove"] = (payload) => {
    roomRef.current?.send("react_remove", payload);
  };
  const typing: UseOrgChatRoomResult["typing"] = (channelId, parentId = null) => {
    roomRef.current?.send("typing", { channelId, parentId });
  };

  return { state, error, room: roomRef.current, send, edit, remove, reactAdd, reactRemove, typing };
}

function wireRoomEvents(
  orgId: string,
  room: ColyseusRoom,
  ctx: {
    qc: ReturnType<typeof useQueryClient>;
    currentUserId: string | null;
  },
) {
  const store = useChatStore.getState();

  room.onMessage("message", (payload: { message: ChatMessage }) => {
    const msg = payload?.message;
    if (!msg) return;
    store.upsertMessage(msg);

    // Don't bump unread on my own messages or when the channel is active.
    const self = ctx.currentUserId;
    if (self && msg.userId === self) return;
    const active = useChatStore.getState().activeChannelId;
    if (active === msg.channelId) return;
    const mentioned =
      self !== null && extractMentionUserIdsClient(msg.content).includes(self);
    bumpChannelUnread(ctx.qc, {
      orgId,
      channelId: msg.channelId,
      mentioned,
    });
    if (mentioned) {
      // A new @mention arrived for me — refresh the cross-channel feed.
      ctx.qc.invalidateQueries({ queryKey: chatKeys.myMentions(orgId) });
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

  // Presence: colyseus state sync.
  const syncPresence = () => {
    const online = room.state?.online;
    if (!online) return;
    const list: {
      userId: string;
      username: string;
      avatarUrl: string;
      since: number;
    }[] = [];
    online.forEach((p: { userId: string; username: string; avatarUrl: string; since: number }) => {
      list.push({
        userId: p.userId,
        username: p.username,
        avatarUrl: p.avatarUrl,
        since: p.since,
      });
    });
    useChatStore.getState().replacePresence(orgId, list);
  };

  try {
    room.onStateChange(() => syncPresence());
    syncPresence();
  } catch {
    // older colyseus clients may not support onStateChange in this shape;
    // ignore and rely solely on explicit "presence" messages if those are added later.
  }
}
