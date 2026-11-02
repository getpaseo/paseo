import { z } from "zod";

import { CodexAppServerResponseTooLargeError } from "./app-server-transport.js";

// Codex clamps history pages to 100 rows.
const PAGE_SIZE = 100;

export interface CodexThreadHistoryClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

export type CodexThreadHistoryMode = "legacy" | "paginated";

export interface CodexHistoryRow {
  item: unknown;
  turnId: string | undefined;
  /** The item's times on a paginated thread; its turn's on a legacy thread. */
  startedAt: unknown;
  completedAt: unknown;
}

/** A history reply over the line cap; the rows before it were already read. */
export class CodexThreadHistoryTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexThreadHistoryTooLargeError";
  }
}

const CodexThreadMetadataSchema = z
  .object({
    thread: z.object({ historyMode: z.enum(["legacy", "paginated"]).optional() }).passthrough(),
  })
  .passthrough();

const CodexLegacyThreadReadSchema = z
  .object({
    thread: z
      .object({
        turns: z
          .array(
            z
              .object({
                id: z.string().optional(),
                startedAt: z.unknown().optional(),
                completedAt: z.unknown().optional(),
                items: z.array(z.unknown()).default([]),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .default({ turns: [] }),
  })
  .passthrough();

const CodexItemsPageSchema = z
  .object({
    data: z.array(
      z
        .object({
          turnId: z.string(),
          item: z.unknown(),
          startedAtMs: z.number().nullable().optional(),
          completedAtMs: z.number().nullable().optional(),
        })
        .passthrough(),
    ),
    nextCursor: z.string().nullable().optional(),
  })
  .passthrough();

/** Codex builds before 0.143 report no history mode; their threads are legacy. */
export async function readCodexThreadHistoryMode(
  client: CodexThreadHistoryClient,
  threadId: string,
): Promise<CodexThreadHistoryMode> {
  const response = CodexThreadMetadataSchema.parse(
    await client.request("thread/read", { threadId, includeTurns: false }),
  );
  return response.thread.historyMode ?? "legacy";
}

/**
 * Reads a thread's persisted items in order. Paginated threads are read in
 * pages; a legacy thread arrives in one `thread/read` reply, as Codex offers
 * no pages for it.
 */
export async function* readCodexThreadHistory(
  client: CodexThreadHistoryClient,
  threadId: string,
): AsyncGenerator<CodexHistoryRow> {
  if ((await readCodexThreadHistoryMode(client, threadId)) === "paginated") {
    yield* readPaginatedHistory(client, threadId);
  } else {
    yield* readLegacyHistory(client, threadId);
  }
}

async function* readLegacyHistory(
  client: CodexThreadHistoryClient,
  threadId: string,
): AsyncGenerator<CodexHistoryRow> {
  const response = await requestHistory(
    client,
    "thread/read",
    { threadId, includeTurns: true },
    `This Codex thread's history is too large to load in one read. ` +
      `To move it to paginated history, archive this agent, ` +
      `run \`codex migrate-rollouts --apply --thread ${threadId}\` (Codex 0.148 or newer), ` +
      `then unarchive the agent.`,
  );
  for (const turn of CodexLegacyThreadReadSchema.parse(response).thread.turns) {
    for (const item of turn.items) {
      yield { item, turnId: turn.id, startedAt: turn.startedAt, completedAt: turn.completedAt };
    }
  }
}

async function* readPaginatedHistory(
  client: CodexThreadHistoryClient,
  threadId: string,
): AsyncGenerator<CodexHistoryRow> {
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = CodexItemsPageSchema.parse(
      await requestHistory(
        client,
        "thread/items/list",
        { threadId, limit: PAGE_SIZE, sortDirection: "asc", cursor },
        "The rest of this Codex thread's history is too large to load.",
      ),
    );
    for (const row of page.data) {
      yield {
        item: row.item,
        turnId: row.turnId,
        startedAt: row.startedAtMs,
        completedAt: row.completedAtMs,
      };
    }
    if (page.nextCursor == null) return;
    // Codex's own client guards against a cursor that does not advance.
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`Codex repeated history cursor for thread ${threadId}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

async function requestHistory(
  client: CodexThreadHistoryClient,
  method: string,
  params: unknown,
  tooLargeMessage: string,
): Promise<unknown> {
  try {
    return await client.request(method, params);
  } catch (error) {
    if (error instanceof CodexAppServerResponseTooLargeError) {
      throw new CodexThreadHistoryTooLargeError(tooLargeMessage);
    }
    throw error;
  }
}
