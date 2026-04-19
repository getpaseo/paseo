/**
 * Minimal client-side mirror of `extractMentionUserIds` from the server lib.
 * Kept in its own file so it can be imported without pulling in the full
 * chat-store / React-query graph (useful for the Colyseus hook).
 */

const MENTION_RE = /<@([a-zA-Z0-9_-]+)>/g;

export function extractMentionUserIdsClient(content: string): string[] {
  const seen = new Set<string>();
  for (const m of content.matchAll(MENTION_RE)) {
    if (m[1]) seen.add(m[1]);
  }
  return Array.from(seen);
}
