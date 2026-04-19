import { useSyncExternalStore } from "react";

/**
 * Buffer of recent `chat_message` broadcasts from the Colyseus shared-session
 * room. Each entry records who sent a given user message so the agent chat
 * stream can label the bubble with the sender's name + avatar when more than
 * one person shares the session.
 *
 * The broadcast is fire-and-forget and the agent's user-message echo arrives
 * through a separate channel (daemon stream). We match by exact content,
 * consuming the oldest entry when the same text shows up in the stream.
 */

export interface ChatAuthor {
  userId: string;
  username: string;
  avatarUrl: string;
  content: string;
  ts: number;
}

const MAX_BUFFER = 64;
const MATCH_WINDOW_MS = 60_000;

let buffer: ChatAuthor[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function pushChatAuthor(author: ChatAuthor): void {
  buffer = [...buffer, author].slice(-MAX_BUFFER);
  emit();
}

export function clearChatAuthors(): void {
  if (buffer.length === 0) return;
  buffer = [];
  emit();
}

/**
 * Find — without consuming — the author who most recently sent the given text.
 * Returns null when no buffered entry matches (either no broadcast received,
 * or the match window expired).
 */
export function findChatAuthor(content: string): ChatAuthor | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const now = Date.now();
  for (let i = buffer.length - 1; i >= 0; i--) {
    const entry = buffer[i]!;
    if (entry.content !== trimmed) continue;
    if (now - entry.ts > MATCH_WINDOW_MS) continue;
    return entry;
  }
  return null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot(): ChatAuthor[] {
  return buffer;
}

export function useChatAuthorFor(content: string | null | undefined): ChatAuthor | null {
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (!content) return null;
  return findChatAuthor(content);
}
