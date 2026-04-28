/**
 * Tracks which remote participants are currently typing in the shared session.
 * Wired from the shared-session room via `typing_status` messages. Each entry
 * auto-expires after TYPING_IDLE_MS so a silent client doesn't leave a stuck
 * "is typing…" bubble if their `typing_stop` message never arrives.
 */

import { useSyncExternalStore } from "react";

export interface TypingUser {
  userId: string;
  username: string;
  avatarUrl: string;
  lastAt: number;
}

const TYPING_IDLE_MS = 4000;

let users: Map<string, TypingUser> = new Map();
const listeners = new Set<() => void>();
let pruneTimer: ReturnType<typeof setInterval> | null = null;

function emit() {
  // New identity so useSyncExternalStore sees a change.
  users = new Map(users);
  for (const l of listeners) l();
}

function ensurePruner() {
  if (pruneTimer) return;
  pruneTimer = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const [id, u] of users) {
      if (now - u.lastAt > TYPING_IDLE_MS) {
        users.delete(id);
        changed = true;
      }
    }
    if (changed) emit();
    if (users.size === 0 && pruneTimer) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  }, 1000);
}

export function setRemoteTyping(user: Omit<TypingUser, "lastAt">, typing: boolean) {
  if (typing) {
    users.set(user.userId, { ...user, lastAt: Date.now() });
    ensurePruner();
  } else {
    if (!users.has(user.userId)) return;
    users.delete(user.userId);
  }
  emit();
}

export function clearAllTyping() {
  if (users.size === 0) return;
  users = new Map();
  emit();
}

export function useTypingUsers(): TypingUser[] {
  const map = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => users,
    () => users,
  );
  return Array.from(map.values());
}

// --- local-typing broadcast -------------------------------------------------

let lastSentTyping = false;
let stopTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Called as the local user types. Sends `typing_start` on the rising edge and
 * schedules a `typing_stop` after idle silence. Safe to call on every keystroke.
 */
export function notifyLocalTyping(room: any) {
  if (!room?.send) return;
  if (!lastSentTyping) {
    lastSentTyping = true;
    try {
      room.send("typing_start");
    } catch {}
  }
  if (stopTimer) clearTimeout(stopTimer);
  stopTimer = setTimeout(() => stopLocalTyping(room), 2500);
}

export function stopLocalTyping(room: any) {
  if (stopTimer) {
    clearTimeout(stopTimer);
    stopTimer = null;
  }
  if (!lastSentTyping) return;
  lastSentTyping = false;
  try {
    room?.send?.("typing_stop");
  } catch {}
}
