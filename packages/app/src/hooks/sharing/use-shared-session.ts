import { useCallback, useEffect, useRef, useState } from "react";
import { joinSharedSession, type Room } from "./colyseus-client";

export interface SharedSessionParticipant {
  userId: string;
  username: string;
  avatarUrl: string;
  role: string;
  audioEnabled: boolean;
  isOnline: boolean;
  joinedAt: number;
}

export interface SharedSessionQueueItem {
  id: string;
  userId: string;
  username: string;
  content: string;
  queuedAt: number;
  status: string;
}

export interface SharedSessionState {
  shareId: string;
  accessLevel: string;
  agentStatus: string;
  participants: Map<string, SharedSessionParticipant>;
  messageQueue: SharedSessionQueueItem[];
}

interface UseSharedSessionOptions {
  shareToken: string | null;
  sessionToken: string | null;
}

export function useSharedSession({ shareToken, sessionToken }: UseSharedSessionOptions) {
  const roomRef = useRef<Room | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [participants, setParticipants] = useState<Map<string, SharedSessionParticipant>>(
    new Map(),
  );
  const [messageQueue, setMessageQueue] = useState<SharedSessionQueueItem[]>([]);
  const [agentStatus, setAgentStatus] = useState("idle");
  const [accessLevel, setAccessLevel] = useState("read_only");

  useEffect(() => {
    if (!shareToken || !sessionToken) return;

    let disposed = false;

    async function connect() {
      try {
        const room = await joinSharedSession({
          shareToken: shareToken!,
          sessionToken: sessionToken!,
        });
        if (disposed) {
          room.leave();
          return;
        }

        roomRef.current = room;
        setConnected(true);
        setError(null);

        // Listen for state changes
        room.state.listen("agentStatus", (value: string) => {
          if (!disposed) setAgentStatus(value);
        });

        room.state.listen("accessLevel", (value: string) => {
          if (!disposed) setAccessLevel(value);
        });

        // Listen for participant changes
        room.state.participants.onAdd((participant: any, key: string) => {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.set(key, {
              userId: participant.userId,
              username: participant.username,
              avatarUrl: participant.avatarUrl,
              role: participant.role,
              audioEnabled: participant.audioEnabled,
              isOnline: participant.isOnline,
              joinedAt: participant.joinedAt,
            });
            return next;
          });

          // Listen for individual participant updates
          participant.onChange(() => {
            setParticipants((prev) => {
              const next = new Map(prev);
              next.set(key, {
                userId: participant.userId,
                username: participant.username,
                avatarUrl: participant.avatarUrl,
                role: participant.role,
                audioEnabled: participant.audioEnabled,
                isOnline: participant.isOnline,
                joinedAt: participant.joinedAt,
              });
              return next;
            });
          });
        });

        room.state.participants.onRemove((_participant: any, key: string) => {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.delete(key);
            return next;
          });
        });

        // Listen for queue changes
        room.state.messageQueue.onAdd((msg: any) => {
          updateQueue(room);
          msg.onChange(() => updateQueue(room));
        });
        room.state.messageQueue.onRemove(() => updateQueue(room));

        // Handle errors
        room.onError((code: number, message: string) => {
          if (!disposed) setError(`Room error: ${message} (${code})`);
        });

        room.onLeave(() => {
          if (!disposed) {
            setConnected(false);
            roomRef.current = null;
          }
        });
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : "Failed to join session");
          setConnected(false);
        }
      }
    }

    function updateQueue(room: Room) {
      const queue: SharedSessionQueueItem[] = [];
      room.state.messageQueue.forEach((msg: any) => {
        queue.push({
          id: msg.id,
          userId: msg.userId,
          username: msg.username,
          content: msg.content,
          queuedAt: msg.queuedAt,
          status: msg.status,
        });
      });
      setMessageQueue(queue);
    }

    void connect();

    return () => {
      disposed = true;
      if (roomRef.current) {
        roomRef.current.leave();
        roomRef.current = null;
      }
    };
  }, [shareToken, sessionToken]);

  const sendMessage = useCallback(
    (content: string) => {
      if (roomRef.current && connected) {
        roomRef.current.send("chat_to_agent", { content });
      }
    },
    [connected],
  );

  const sendWebRTCSignal = useCallback(
    (targetUserId: string, kind: string, data: unknown) => {
      if (roomRef.current && connected) {
        roomRef.current.send("webrtc_signal", { targetUserId, kind, data });
      }
    },
    [connected],
  );

  const toggleAudio = useCallback(
    (enabled: boolean) => {
      if (roomRef.current && connected) {
        roomRef.current.send("audio_toggle", { enabled });
      }
    },
    [connected],
  );

  const leave = useCallback(() => {
    if (roomRef.current) {
      roomRef.current.leave();
      roomRef.current = null;
      setConnected(false);
    }
  }, []);

  return {
    room: roomRef.current,
    connected,
    error,
    participants,
    messageQueue,
    agentStatus,
    accessLevel,
    sendMessage,
    sendWebRTCSignal,
    toggleAudio,
    leave,
  };
}
