import { z } from "zod";

import { CodexAppServerResponseTooLargeError } from "./app-server-transport.js";

// Codex clamps history pages to 100 rows.
const PAGE_SIZE = 100;

export interface CodexThreadHistoryClient {
  request(method: string, params?: unknown): Promise<unknown>;
}

export type CodexThreadHistoryMode = "legacy" | "paginated";
export type CodexHistoryStatus = "running" | "completed" | "failed" | "canceled";

export interface CodexHistoryRow {
  item: unknown;
  turnId: string | undefined;
  /** The item's times on a paginated thread; its turn's on a legacy thread. */
  startedAt: unknown;
  completedAt: unknown;
}

interface CodexThreadHistoryRead {
  rows: Iterable<CodexHistoryRow> | AsyncIterable<CodexHistoryRow>;
  status: CodexHistoryStatus | null;
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
    thread: z
      .object({
        historyMode: z.enum(["legacy", "paginated"]).optional(),
        status: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexLegacyTurnSchema = z
  .object({
    id: z.string().optional(),
    startedAt: z.unknown().optional(),
    completedAt: z.unknown().optional(),
    status: z.unknown().optional(),
    items: z.array(z.unknown()).default([]),
  })
  .passthrough();

const CodexLegacyThreadReadSchema = z
  .object({
    thread: z
      .object({
        status: z.unknown().optional(),
        turns: z.array(CodexLegacyTurnSchema).default([]),
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

const CodexLatestTurnPageSchema = z.object({
  data: z.array(z.object({ status: z.unknown().optional() })),
});

/** Codex builds before 0.143 report no history mode; their threads are legacy. */
export async function readCodexThreadHistoryMode(
  client: CodexThreadHistoryClient,
  threadId: string,
): Promise<CodexThreadHistoryMode> {
  return (await readThreadMetadata(client, threadId)).historyMode ?? "legacy";
}

async function readThreadMetadata(client: CodexThreadHistoryClient, threadId: string) {
  return CodexThreadMetadataSchema.parse(
    await client.request("thread/read", { threadId, includeTurns: false }),
  ).thread;
}

function readHistoryStatus(
  threadStatus: unknown,
  latestTurnStatus?: unknown,
): CodexHistoryStatus | null {
  if (
    typeof threadStatus === "object" &&
    threadStatus !== null &&
    "type" in threadStatus &&
    threadStatus.type === "active"
  ) {
    return "running";
  }
  // An unloaded thread can contain an unfinished rollout. Only the runtime
  // status proves that it is still working.
  switch (latestTurnStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "canceled";
    default:
      return null;
  }
}

/**
 * Reads a thread's persisted items in order. Paginated threads are read in
 * pages; a legacy thread arrives in one `thread/read` reply, as Codex offers
 * no pages for it.
 */
export async function readCodexThreadHistory(
  client: CodexThreadHistoryClient,
  threadId: string,
  options?: { readLatestTurn?: boolean },
): Promise<CodexThreadHistoryRead> {
  const metadata = await readThreadMetadata(client, threadId);
  if (metadata.historyMode === "paginated") {
    const active = readHistoryStatus(metadata.status);
    return {
      rows: readPaginatedHistory(client, threadId),
      status:
        active ?? (options?.readLatestTurn ? await readLatestTurnStatus(client, threadId) : null),
    };
  }
  const response = await requestHistory(
    client,
    "thread/read",
    { threadId, includeTurns: true },
    `This Codex thread's history is too large to load in one read. ` +
      `To move it to paginated history, archive this agent, ` +
      `run \`codex migrate-rollouts --apply --thread ${threadId}\` (Codex 0.148 or newer), ` +
      `then unarchive the agent.`,
  );
  const { thread } = CodexLegacyThreadReadSchema.parse(response);
  return {
    rows: readLegacyRows(thread.turns),
    status: readHistoryStatus(thread.status, thread.turns.at(-1)?.status),
  };
}

async function readLatestTurnStatus(
  client: CodexThreadHistoryClient,
  threadId: string,
): Promise<CodexHistoryStatus | null> {
  try {
    const response = await client.request("thread/turns/list", {
      threadId,
      limit: 1,
      sortDirection: "desc",
      itemsView: "notLoaded",
    });
    const page = CodexLatestTurnPageSchema.parse(response);
    return readHistoryStatus(undefined, page.data[0]?.status);
  } catch {
    // Older Codex builds and stores can reject this optional probe. The
    // recorded parent outcome and the child's timeline still load normally.
    return null;
  }
}

function* readLegacyRows(
  turns: z.infer<typeof CodexLegacyTurnSchema>[],
): Generator<CodexHistoryRow> {
  for (const turn of turns) {
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
  let limit = PAGE_SIZE;
  for (;;) {
    let response: unknown;
    try {
      response = await client.request("thread/items/list", {
        threadId,
        limit,
        sortDirection: "asc",
        cursor,
      });
    } catch (error) {
      if (!(error instanceof CodexAppServerResponseTooLargeError)) throw error;
      // Image-heavy items can push a full page past the line cap; retry the same cursor smaller.
      if (limit > 1) {
        limit = Math.max(1, Math.floor(limit / 2));
        continue;
      }
      throw new CodexThreadHistoryTooLargeError(
        "The rest of this Codex thread's history is too large to load.",
      );
    }
    const page = CodexItemsPageSchema.parse(response);
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
