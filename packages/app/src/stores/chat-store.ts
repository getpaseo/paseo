import { create } from "zustand";
import { createJSONStorage, persist, subscribeWithSelector } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ChatChannel, ChatMessage, ChatReactionGroup } from "@/api/chat";
import type { OrgMember } from "@/api/organizations";

/** Per-channel cap. Keeps AsyncStorage small; HTTP refills on load. */
const PERSIST_MAX_MESSAGES_PER_CHANNEL = 60;
const CHAT_STORE_VERSION = 1;

export interface ChatPresence {
  userId: string;
  username: string;
  avatarUrl: string;
  since: number;
}

export interface TypingIndicator {
  userId: string;
  username: string;
  at: number;
  /** When set, the user is typing in a thread (parent message id). */
  parentId?: string | null;
}

interface ChatState {
  /** Per-channel ordered message list (oldest → newest). */
  messagesByChannel: Record<string, ChatMessage[]>;
  /** messageId → reactions aggregated per emoji. */
  reactionsByMessage: Record<string, ChatReactionGroup[]>;
  /** orgId → (userId → presence). */
  presenceByOrg: Record<string, Record<string, ChatPresence>>;
  /** channelId → (userId → TypingIndicator). */
  typingByChannel: Record<string, Record<string, TypingIndicator>>;
  /** Per-org channel list cache (for instant-paint on app boot). */
  channelsByOrg: Record<string, ChatChannel[]>;
  /** Per-org DM channel cache. */
  dmsByOrg: Record<string, ChatChannel[]>;
  /** Per-org member list cache. */
  orgMembersByOrg: Record<string, OrgMember[]>;
  setChannelsForOrg: (orgId: string, channels: ChatChannel[]) => void;
  setDmsForOrg: (orgId: string, dms: ChatChannel[]) => void;
  setOrgMembersForOrg: (orgId: string, members: OrgMember[]) => void;

  /** Currently-focused channel. Used to decide when to bump unread or not. */
  activeChannelId: string | null;
  setActiveChannelId: (id: string | null) => void;

  // Bulk initial loads (from REST)
  setMessages: (channelId: string, messages: ChatMessage[]) => void;
  prependMessages: (channelId: string, olderMessages: ChatMessage[]) => void;
  setReactions: (messageId: string, reactions: ChatReactionGroup[]) => void;

  // Realtime events (from Colyseus)
  upsertMessage: (message: ChatMessage) => void;
  updateMessage: (message: ChatMessage) => void;
  removeMessage: (messageId: string) => void;
  /** Hard-removes a row (used for optimistic placeholders). */
  dropMessage: (messageId: string) => void;
  applyReaction: (
    op: "add" | "remove",
    payload: { messageId: string; userId: string; emoji: string },
  ) => void;

  // Presence & typing
  replacePresence: (orgId: string, presence: ChatPresence[]) => void;
  upsertPresence: (orgId: string, presence: ChatPresence) => void;
  removePresence: (orgId: string, userId: string) => void;
  setTyping: (channelId: string, indicator: TypingIndicator) => void;
  clearStaleTyping: () => void;
  clearTypingForUser: (channelId: string, userId: string) => void;

  reset: () => void;
}

const TYPING_TTL_MS = 5_000;

export const useChatStore = create<ChatState>()(
  persist(
    subscribeWithSelector((set, get) => ({
      messagesByChannel: {},
      reactionsByMessage: {},
      presenceByOrg: {},
      typingByChannel: {},
      channelsByOrg: {},
      dmsByOrg: {},
      orgMembersByOrg: {},
      activeChannelId: null,

      setActiveChannelId: (id) => set({ activeChannelId: id }),

      setChannelsForOrg: (orgId, channels) =>
        set((s) => ({ channelsByOrg: { ...s.channelsByOrg, [orgId]: channels } })),
      setDmsForOrg: (orgId, dms) => set((s) => ({ dmsByOrg: { ...s.dmsByOrg, [orgId]: dms } })),
      setOrgMembersForOrg: (orgId, members) =>
        set((s) => ({ orgMembersByOrg: { ...s.orgMembersByOrg, [orgId]: members } })),

      setMessages: (channelId, messages) =>
        set((s) => {
          const nextReactions = { ...s.reactionsByMessage };
          for (const m of messages) {
            if (m.reactions && m.reactions.length > 0) {
              nextReactions[m.id] = m.reactions;
            }
          }
          return {
            messagesByChannel: {
              ...s.messagesByChannel,
              [channelId]: [...messages].sort(compareMessages),
            },
            reactionsByMessage: nextReactions,
          };
        }),

      prependMessages: (channelId, olderMessages) =>
        set((s) => {
          const existing = s.messagesByChannel[channelId] ?? [];
          const seen = new Set(existing.map((m) => m.id));
          const merged = [...olderMessages.filter((m) => !seen.has(m.id)), ...existing];
          merged.sort(compareMessages);
          const nextReactions = { ...s.reactionsByMessage };
          for (const m of olderMessages) {
            if (m.reactions && m.reactions.length > 0) {
              nextReactions[m.id] = m.reactions;
            }
          }
          return {
            messagesByChannel: { ...s.messagesByChannel, [channelId]: merged },
            reactionsByMessage: nextReactions,
          };
        }),

      setReactions: (messageId, reactions) =>
        set((s) => ({
          reactionsByMessage: { ...s.reactionsByMessage, [messageId]: reactions },
        })),

      upsertMessage: (message) =>
        set((s) => {
          const arr = s.messagesByChannel[message.channelId] ?? [];
          const idx = arr.findIndex((m) => m.id === message.id);
          const next =
            idx === -1 ? [...arr, message] : arr.map((m) => (m.id === message.id ? message : m));
          next.sort(compareMessages);
          const reactionsPatch =
            message.reactions && message.reactions.length > 0
              ? { [message.id]: message.reactions }
              : null;
          return {
            messagesByChannel: { ...s.messagesByChannel, [message.channelId]: next },
            ...(reactionsPatch
              ? { reactionsByMessage: { ...s.reactionsByMessage, ...reactionsPatch } }
              : {}),
          };
        }),

      updateMessage: (message) =>
        set((s) => {
          const arr = s.messagesByChannel[message.channelId];
          if (!arr) return {};
          const next = arr.map((m) => (m.id === message.id ? message : m));
          return {
            messagesByChannel: { ...s.messagesByChannel, [message.channelId]: next },
          };
        }),

      dropMessage: (messageId) =>
        set((s) => {
          const patched: Record<string, ChatMessage[]> = {};
          let changed = false;
          for (const [cid, arr] of Object.entries(s.messagesByChannel)) {
            const next = arr.filter((m) => m.id !== messageId);
            if (next.length !== arr.length) {
              patched[cid] = next;
              changed = true;
            }
          }
          if (!changed) return {};
          return { messagesByChannel: { ...s.messagesByChannel, ...patched } };
        }),

      removeMessage: (messageId) =>
        set((s) => {
          const patched: Record<string, ChatMessage[]> = {};
          let changed = false;
          for (const [cid, arr] of Object.entries(s.messagesByChannel)) {
            const next = arr.map((m) =>
              m.id === messageId ? { ...m, deletedAt: new Date().toISOString(), content: "" } : m,
            );
            if (next !== arr) {
              patched[cid] = next;
              changed = true;
            }
          }
          if (!changed) return {};
          return { messagesByChannel: { ...s.messagesByChannel, ...patched } };
        }),

      applyReaction: (op, { messageId, userId, emoji }) =>
        set((s) => {
          const current = s.reactionsByMessage[messageId] ?? [];
          const group = current.find((g) => g.emoji === emoji);
          let next: ChatReactionGroup[];
          if (op === "add") {
            if (group) {
              if (group.userIds.includes(userId)) return {};
              next = current.map((g) =>
                g.emoji === emoji
                  ? { ...g, userIds: [...g.userIds, userId], count: g.count + 1 }
                  : g,
              );
            } else {
              next = [...current, { emoji, userIds: [userId], count: 1 }];
            }
          } else {
            if (!group) return {};
            const filteredUsers = group.userIds.filter((u) => u !== userId);
            if (filteredUsers.length === 0) {
              next = current.filter((g) => g.emoji !== emoji);
            } else {
              next = current.map((g) =>
                g.emoji === emoji
                  ? { ...g, userIds: filteredUsers, count: filteredUsers.length }
                  : g,
              );
            }
          }
          return {
            reactionsByMessage: { ...s.reactionsByMessage, [messageId]: next },
          };
        }),

      replacePresence: (orgId, presence) =>
        set((s) => ({
          presenceByOrg: {
            ...s.presenceByOrg,
            [orgId]: Object.fromEntries(presence.map((p) => [p.userId, p])),
          },
        })),

      upsertPresence: (orgId, presence) =>
        set((s) => ({
          presenceByOrg: {
            ...s.presenceByOrg,
            [orgId]: { ...(s.presenceByOrg[orgId] ?? {}), [presence.userId]: presence },
          },
        })),

      removePresence: (orgId, userId) =>
        set((s) => {
          const org = s.presenceByOrg[orgId];
          if (!org) return {};
          const { [userId]: _, ...rest } = org;
          return { presenceByOrg: { ...s.presenceByOrg, [orgId]: rest } };
        }),

      setTyping: (channelId, indicator) =>
        set((s) => ({
          typingByChannel: {
            ...s.typingByChannel,
            [channelId]: {
              ...(s.typingByChannel[channelId] ?? {}),
              [indicator.userId]: indicator,
            },
          },
        })),

      clearTypingForUser: (channelId, userId) =>
        set((s) => {
          const byUser = s.typingByChannel[channelId];
          if (!byUser || !(userId in byUser)) return {};
          const { [userId]: _gone, ...rest } = byUser;
          return { typingByChannel: { ...s.typingByChannel, [channelId]: rest } };
        }),

      clearStaleTyping: () =>
        set((s) => {
          const cutoff = Date.now() - TYPING_TTL_MS;
          const patched: Record<string, Record<string, TypingIndicator>> = {};
          let changed = false;
          for (const [channelId, byUser] of Object.entries(s.typingByChannel)) {
            const remaining = Object.fromEntries(
              Object.entries(byUser).filter(([, t]) => t.at >= cutoff),
            );
            if (Object.keys(remaining).length !== Object.keys(byUser).length) {
              patched[channelId] = remaining;
              changed = true;
            }
          }
          if (!changed) return {};
          return { typingByChannel: { ...s.typingByChannel, ...patched } };
        }),

      reset: () =>
        set({
          messagesByChannel: {},
          reactionsByMessage: {},
          presenceByOrg: {},
          typingByChannel: {},
          channelsByOrg: {},
          dmsByOrg: {},
          orgMembersByOrg: {},
          activeChannelId: null,
        }),
    })),
    {
      name: "hubcode-chat",
      version: CHAT_STORE_VERSION,
      storage: createJSONStorage(() => AsyncStorage),
      // Only persist the conversation data. Presence, typing, and the active
      // channel are session-scoped — re-derived on boot.
      partialize: (state) => {
        const cappedMessages: Record<string, ChatMessage[]> = {};
        const keptMessageIds = new Set<string>();
        for (const [cid, arr] of Object.entries(state.messagesByChannel)) {
          // Keep only the most recent N per channel so the cache stays lean.
          const tail = arr.slice(-PERSIST_MAX_MESSAGES_PER_CHANNEL);
          cappedMessages[cid] = tail;
          for (const m of tail) keptMessageIds.add(m.id);
        }
        const cappedReactions: Record<string, ChatReactionGroup[]> = {};
        for (const id of keptMessageIds) {
          const r = state.reactionsByMessage[id];
          if (r && r.length > 0) cappedReactions[id] = r;
        }
        return {
          messagesByChannel: cappedMessages,
          reactionsByMessage: cappedReactions,
          channelsByOrg: state.channelsByOrg,
          dmsByOrg: state.dmsByOrg,
          orgMembersByOrg: state.orgMembersByOrg,
        } as Partial<ChatState>;
      },
    },
  ),
);

function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.id.localeCompare(b.id);
}

// Selectors
export const selectChannelMessages = (channelId: string) => (s: ChatState) =>
  s.messagesByChannel[channelId] ?? EMPTY_MESSAGES;

export const selectMessageReactions = (messageId: string) => (s: ChatState) =>
  s.reactionsByMessage[messageId] ?? EMPTY_REACTIONS;

export const selectOrgPresence = (orgId: string) => (s: ChatState) =>
  s.presenceByOrg[orgId] ?? EMPTY_PRESENCE;

export const selectTyping = (channelId: string) => (s: ChatState) =>
  s.typingByChannel[channelId] ?? EMPTY_TYPING;

const EMPTY_MESSAGES: readonly ChatMessage[] = Object.freeze([]);
const EMPTY_REACTIONS: readonly ChatReactionGroup[] = Object.freeze([]);
const EMPTY_PRESENCE: Readonly<Record<string, ChatPresence>> = Object.freeze({});
const EMPTY_TYPING: Readonly<Record<string, TypingIndicator>> = Object.freeze({});
