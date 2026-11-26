import type { SessionMessageInfo } from "@opencode/client";
import type { V2Api } from "./api.js";

const TAIL_PAGE_LIMIT = 25;
const MAX_TAIL_PAGES = 8;

export interface TailSyncResult {
  history: SessionMessageInfo[];
  startIndex: number;
}

export async function messages(client: V2Api, sessionID: string): Promise<SessionMessageInfo[]> {
  const result: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.message.list({
      sessionID,
      ...(cursor ? { cursor } : { order: "asc" }),
      limit: 100,
    });
    result.push(...page.data);
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
  return result;
}

/**
 * Fetches only the newest tail of a session's messages in descending order until it
 * overlaps already-synced history, avoiding O(N) full-history reloads on live events.
 * Falls back to a full ascending sync if more than maxPages * limit unseen messages exist.
 */
export async function syncTailMessages(
  client: V2Api,
  sessionID: string,
  existing: readonly SessionMessageInfo[],
  options?: { limit?: number; maxPages?: number; signal?: AbortSignal },
): Promise<TailSyncResult> {
  const limit = options?.limit ?? TAIL_PAGE_LIMIT;
  const maxPages = options?.maxPages ?? MAX_TAIL_PAGES;
  const requestOptions = options?.signal ? { signal: options.signal } : undefined;
  const indexById = new Map<string, number>();
  for (let i = 0; i < existing.length; i++) indexById.set(existing[i].id, i);

  const descending: SessionMessageInfo[] = [];
  let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
    // OpenCode rejects combining cursor with order (InvalidCursorError).
    const page = await client.message.list(
      {
        sessionID,
        ...(cursor ? { cursor } : { order: "desc" }),
        limit,
      },
      requestOptions,
    );
    descending.push(...page.data);
    cursor = page.cursor.next ?? undefined;

    const oldest = descending.at(-1);
    if (oldest && indexById.has(oldest.id)) {
      const overlapIndex = indexById.get(oldest.id)!;
      const tail = descending.toReversed();
      return {
        history: [...existing.slice(0, overlapIndex), ...tail],
        startIndex: overlapIndex,
      };
    }
    if (!cursor) {
      return {
        history: descending.toReversed(),
        startIndex: 0,
      };
    }
  }

  const full = await messages(client, sessionID);
  return { history: full, startIndex: 0 };
}
