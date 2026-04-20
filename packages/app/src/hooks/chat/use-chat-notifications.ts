import { useEffect, useRef } from "react";
import { useRouter } from "expo-router";
import type { ColyseusRoom } from "@/hooks/sharing/colyseus-client";
import type { ChatChannel, ChatMessage } from "@/api/chat";
import type { OrgMember } from "@/api/organizations";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useChatStore } from "@/stores/chat-store";
import { extractMentionUserIdsClient } from "@/lib/chat-mentions";

interface Params {
  room: ColyseusRoom | null;
  currentUserId: string | null;
  orgId: string | null;
  channels: ChatChannel[];
  dms?: ChatChannel[];
  members?: OrgMember[];
}

/**
 * Reacts to incoming realtime chat messages and surfaces toast + optional
 * native OS notifications when the viewer isn't looking at the channel.
 *
 * Notification rules (per channel's `notifyPref`):
 *   - "nothing" or `muted`: never notify
 *   - "mentions": only when message mentions the current user
 *   - "all" (default): always notify for messages not authored by self
 *
 * Additional suppression: if the active channel matches the message's
 * channel AND the app window is focused, skip — the user is clearly reading.
 */
export function useChatNotifications(params: Params): void {
  const { room, currentUserId, orgId, channels, dms, members } = params;
  const toast = useToast();
  const router = useRouter();

  // Keep a live ref so the listener always sees the latest channel list
  // without re-subscribing on every channel-list update.
  const depsRef = useRef({ channels, dms, members, currentUserId, orgId });
  useEffect(() => {
    depsRef.current = { channels, dms, members, currentUserId, orgId };
  }, [channels, dms, members, currentUserId, orgId]);

  // Request OS notification permission lazily once the hook is mounted
  // (i.e. once the user has opened the chat screen at least once).
  useEffect(() => {
    if (!isWeb) return;
    if (typeof window === "undefined") return;
    const N = (window as unknown as { Notification?: typeof Notification }).Notification;
    if (!N) return;
    if (N.permission === "default") {
      try {
        N.requestPermission().catch(() => {
          // ignore — user declined or prompt was blocked
        });
      } catch {
        // older browsers throw on silent rejection
      }
    }
  }, []);

  useEffect(() => {
    if (!room) return;
    const handler = (payload: { message: ChatMessage }) => {
      const msg = payload?.message;
      if (!msg) return;
      const {
        channels: curChannels,
        dms: curDms,
        members: curMembers,
        currentUserId: selfId,
        orgId: curOrgId,
      } = depsRef.current;
      if (!selfId || msg.userId === selfId) return;

      const channel =
        curChannels.find((c) => c.id === msg.channelId) ??
        curDms?.find((c) => c.id === msg.channelId) ??
        null;
      const notifyPref = channel?.notifyPref ?? "all";
      const muted = channel?.muted ?? false;
      if (muted || notifyPref === "nothing") return;

      const mentioned = extractMentionUserIdsClient(msg.content).includes(selfId);
      if (notifyPref === "mentions" && !mentioned) return;

      // Suppress when the channel is currently active AND the window has focus.
      const activeChannelId = useChatStore.getState().activeChannelId;
      const windowFocused = isWindowFocused();
      if (activeChannelId === msg.channelId && windowFocused) return;

      const authorName =
        curMembers?.find((m) => m.userId === msg.userId)?.user?.name ?? "Someone";
      const channelLabel = channel
        ? channel.kind === "dm"
          ? authorName
          : `#${channel.name ?? "channel"}`
        : "a channel";
      const preview = previewOf(msg.content);
      const toastMsg = mentioned
        ? `${authorName} mentioned you in ${channelLabel}`
        : `${authorName} in ${channelLabel}: ${preview}`;

      // In-app toast.
      toast.show(toastMsg);

      // OS notification on web/Electron when permission is granted.
      if (isWeb && typeof window !== "undefined") {
        const N = (window as unknown as { Notification?: typeof Notification }).Notification;
        if (N && N.permission === "granted") {
          try {
            const n = new N(channelLabel, {
              body: `${authorName}: ${preview}`,
              tag: `hubcode-chat-${msg.channelId}`,
            });
            n.onclick = () => {
              try {
                window.focus();
              } catch {
                // ignore
              }
              navigateToMessage(router, msg.channelId, msg.id);
              try {
                n.close();
              } catch {
                // ignore
              }
            };
          } catch {
            // ignore: permission revoked mid-flight, or browser quirk
          }
        }
      }

      // Swallow orgId lint (kept for future: push-notifications API).
      void curOrgId;
    };

    room.onMessage("message", handler);
    // Colyseus' `onMessage` appends listeners; leaving the room clears them.
    // If the room instance changes (new connection), the effect cleans up by
    // dropping the closure — the stale room was already torn down by
    // `useOrgChatRoom`'s cleanup.
    return () => {
      // No public `off` API on Colyseus rooms — rely on room teardown.
    };
  }, [room, toast, router]);
}

function isWindowFocused(): boolean {
  if (!isWeb) return true; // on native, assume focused when app is foregrounded
  if (typeof document === "undefined") return true;
  if (typeof document.hasFocus === "function") {
    try {
      return document.hasFocus();
    } catch {
      return true;
    }
  }
  return document.visibilityState !== "hidden";
}

function previewOf(content: string): string {
  // Strip mention tokens for a cleaner preview, then trim.
  const cleaned = content.replace(/<@([a-zA-Z0-9_-]+)>/g, "@mention").trim();
  if (cleaned.length <= 80) return cleaned;
  return `${cleaned.slice(0, 77)}…`;
}

function navigateToMessage(
  router: ReturnType<typeof useRouter>,
  channelId: string,
  messageId: string,
): void {
  try {
    router.push({
      pathname: "/chat",
      params: { channel: channelId, m: messageId },
    });
  } catch {
    // ignore navigation failures
  }
}
