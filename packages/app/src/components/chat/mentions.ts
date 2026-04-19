/**
 * Mention format shared between composer, renderer, and server:
 *   <@userId>   → renders as bold "@Name" linked to that user
 *   <#channelId> → renders as bold "#channel-name"
 *
 * These are plain-text tokens inside a markdown string so they survive
 * round-trips through the REST API, Colyseus broadcasts, and mobile/web
 * renderers without structured metadata.
 */

import type { ChatChannel, ChatMember } from "@/api/chat";

export interface MentionMaps {
  membersById: Map<string, ChatMember>;
  channelsById: Map<string, ChatChannel>;
}

const MENTION_RE = /<@([a-zA-Z0-9_-]+)>/g;
const CHANNEL_RE = /<#([a-zA-Z0-9_-]+)>/g;

/**
 * Replace `<@id>` and `<#id>` tokens in markdown-source text with rendered
 * markdown emphasis so `react-native-markdown-display` shows them correctly.
 */
export function expandMentions(content: string, maps: MentionMaps): string {
  let out = content.replace(MENTION_RE, (match, userId: string) => {
    const name = maps.membersById.get(userId)?.name;
    if (!name) return match;
    return `**@${name}**`;
  });
  out = out.replace(CHANNEL_RE, (match, channelId: string) => {
    const channel = maps.channelsById.get(channelId);
    const name = channel?.name;
    if (!name) return match;
    return `**#${name}**`;
  });
  return out;
}

/**
 * Preprocess a message for rendering:
 *  - expands `<@id>` / `<#id>` via {@link expandMentions}
 *  - turns `- [ ]` / `- [x]` task markers into visual checkboxes
 *  - replaces spoiler spans `||text||` with redacted block glyphs
 *
 * Spoiler reveal-on-tap would need per-span local state; we ship the
 * obfuscated form first and can wire interactivity in a later pass.
 */
export function preprocessMarkdown(content: string, maps: MentionMaps): string {
  let out = expandMentions(content, maps);
  out = out.replace(/^(\s*[-*]\s+)\[\s\](\s)/gm, "$1☐$2");
  out = out.replace(/^(\s*[-*]\s+)\[[xX]\](\s)/gm, "$1☑$2");
  out = out.replace(/\|\|([^|\n]+?)\|\|/g, (_m, hidden: string) => {
    const width = Math.max(3, Math.min(24, hidden.length));
    return "▓".repeat(width);
  });
  return out;
}

/**
 * Given a textarea's raw value + caret position, figure out whether the user
 * is actively typing a mention trigger (`@` or `#`) and if so, return the
 * query prefix + the span to replace on selection.
 */
export interface MentionTrigger {
  kind: "@" | "#";
  query: string;
  startIndex: number; // inclusive, points at the trigger char
  endIndex: number; // exclusive
}

export function detectMentionTrigger(
  text: string,
  caret: number,
): MentionTrigger | null {
  if (caret <= 0) return null;
  // Scan backwards from caret to find the nearest trigger char without a space
  // in between.
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@" || ch === "#") {
      // Trigger must follow a whitespace or line start to count.
      const prev = i > 0 ? text[i - 1] : " ";
      if (prev !== undefined && /\s/.test(prev) === false && i !== 0) return null;
      return {
        kind: ch,
        query: text.slice(i + 1, caret),
        startIndex: i,
        endIndex: caret,
      };
    }
    if (ch !== undefined && /\s/.test(ch)) return null;
  }
  return null;
}

export function filterMembersByQuery(
  members: ChatMember[],
  query: string,
  limit = 8,
): ChatMember[] {
  const q = query.trim().toLowerCase();
  if (!q) return members.slice(0, limit);
  const scored = members
    .map((m) => {
      const name = m.name.toLowerCase();
      const email = m.email.toLowerCase();
      if (name.startsWith(q)) return { m, score: 3 };
      if (email.startsWith(q)) return { m, score: 2 };
      if (name.includes(q) || email.includes(q)) return { m, score: 1 };
      return null;
    })
    .filter((v): v is { m: ChatMember; score: number } => v !== null)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.m);
}

export function filterChannelsByQuery(
  channels: ChatChannel[],
  query: string,
  limit = 8,
): ChatChannel[] {
  const q = query.trim().toLowerCase();
  const named = channels.filter((c) => c.name !== null && c.kind !== "dm");
  if (!q) return named.slice(0, limit);
  return named
    .filter((c) => (c.name ?? "").toLowerCase().includes(q))
    .slice(0, limit);
}
