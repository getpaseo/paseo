/**
 * Human-to-human chat inside the shared session (the "Messages" panel on
 * the floating video widget). Lives over Colyseus — the server keeps
 * the last N messages in memory and replays them to late joiners via a
 * `session_chat_history` event.
 *
 * Intentionally distinct from `shared-chat-authors-store` (which tags
 * the author of agent user-messages) — this one is purely peer chat.
 */

import { useSyncExternalStore } from "react";

export interface SessionChatMessage {
  id: string;
  userId: string;
  username: string;
  avatarUrl: string;
  content: string;
  ts: number;
}

const MAX_MESSAGES = 300;

let messages: SessionChatMessage[] = [];
const listeners = new Set<() => void>();
let wiredRoom: any = null;

function emit(): void {
  // New array identity so useSyncExternalStore fires.
  messages = messages.slice();
  for (const l of listeners) l();
}

function upsert(entry: SessionChatMessage): void {
  if (messages.some((m) => m.id === entry.id)) return;
  messages.push(entry);
  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
  // Keep chronological — server normally sends in order but replay + live
  // can race, so re-sort by ts on every insert is cheap enough.
  messages.sort((a, b) => a.ts - b.ts);
  emit();
}

/** Attach listeners for `session_chat_history` + `session_chat_new` on a
 * Colyseus room. Safe to call multiple times with the same room; no-ops
 * after the first call until the room changes. */
export function wireSessionChatListeners(room: any): void {
  if (!room) return;
  if (wiredRoom === room) return;
  wiredRoom = room;
  try {
    room.onMessage?.("session_chat_history", (payload: { entries?: SessionChatMessage[] }) => {
      const entries = Array.isArray(payload?.entries) ? payload.entries : [];
      for (const e of entries) upsert(e);
    });
    room.onMessage?.("session_chat_new", (payload: SessionChatMessage) => {
      if (!payload?.id) return;
      upsert(payload);
    });
  } catch (err) {
    console.warn("[session-chat] failed to wire listeners:", err);
  }
}

export function clearSessionChat(): void {
  wiredRoom = null;
  if (messages.length === 0) return;
  messages = [];
  emit();
}

export function sendSessionChat(room: any, content: string): void {
  const trimmed = content.trim();
  if (!trimmed || !room?.send) return;
  try {
    room.send("session_chat_send", { content: trimmed });
  } catch (err) {
    console.warn("[session-chat] send failed:", err);
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SessionChatMessage[] {
  return messages;
}

export function useSessionChatMessages(): SessionChatMessage[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
