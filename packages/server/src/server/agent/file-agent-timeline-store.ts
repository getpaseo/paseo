import { appendFile, mkdir, open, readFile, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";

import {
  projectTimelineRows,
  selectProjectedEntriesTail,
  selectProjectedTimelinePage,
  tailBoundaryRowCrosses,
} from "./timeline-projection.js";
import {
  DEFAULT_TIMELINE_FETCH_LIMIT,
  TIMELINE_TAIL_BACKFILL_BATCH_ROWS,
  TIMELINE_TAIL_BACKFILL_MAX_SCAN_ROWS,
} from "./agent-timeline-store.js";
import { timelineItemIdentity } from "@getpaseo/protocol/timeline-identity";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
  AgentTimelineTailRead,
} from "./agent-timeline-store-types.js";

export interface FileAgentTimelineStoreOptions {
  /** Directory holding one append-only `{agentId}.jsonl` log per agent. */
  directory: string;
}

const SavedTimelineRowSchema = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  // Validate the wire shape while preserving provider extension fields on
  // tool/compaction items; parsing the wire schema would strip those fields.
  item: z.custom<AgentTimelineItem>(
    (item) => AgentTimelineItemPayloadSchema.safeParse(item).success,
  ),
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

/**
 * Durable, append-only timeline store: one JSONL file per agent under
 * `{directory}/{agentId}.jsonl`. Every committed row is appended; updates
 * append a new line for the same seq (last write wins at read time). Reads
 * skip empty and torn lines, so a crash mid-append loses at most the partial
 * trailing line.
 *
 * There is deliberately no resident cache: keeping the full history in memory
 * is exactly the unbounded retention this store replaces.
 */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly directory: string;
  private readonly writeChains = new Map<string, Promise<void>>();

  constructor(options: FileAgentTimelineStoreOptions) {
    this.directory = options.directory;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return this.enqueueWrite(agentId, async () => {
      // Mint the seq inside the chain: the read-latest and the append
      // serialize with every other write, so concurrent appends get distinct
      // seqs instead of overwriting each other at read time.
      const seq = (await this.getLatestCommittedSeq(agentId)) + 1;
      const row: AgentTimelineRow = {
        seq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      };
      await this.appendRowLines(agentId, [FileAgentTimelineStore.serializeRow(row)]);
      return row;
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const direction = options?.direction ?? "tail";
    const limit = options?.limit ?? DEFAULT_TIMELINE_FETCH_LIMIT;
    // A tail request scans the log from the end. The first read has no seq
    // bound, and a suffix alone cannot know the file's newest seq, so it
    // covers the file; the backward scan above it stays bounded. Other
    // directions and limit 0 keep the full read (they ask for more than a
    // tail can answer).
    if (direction === "tail" && limit > 0) {
      const bounded = await this.fetchCommittedTail(agentId, limit);
      if (bounded !== null) return bounded;
    }
    const rows = await this.getCommittedRows(agentId);
    const minSeq = rows.length > 0 ? rows[0].seq : 0;
    const maxSeq = rows.length > 0 ? rows[rows.length - 1].seq : 0;
    const page = selectProjectedTimelinePage({
      rows,
      bounds: { minSeq, maxSeq },
      direction,
      cursorSeq: options?.cursor?.seq,
      limit,
    });
    return {
      epoch: "",
      direction,
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      hasOlder: page.hasOlder,
      hasNewer: page.hasNewer,
      startSeq: page.startSeq,
      endSeq: page.endSeq,
      rows: page.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  /**
   * Serve a tail page from a backward scan: batches of rows read from the
   * end of the log, each followed by a single-row probe of the row directly
   * above the collected suffix; the scan extends while that row can still
   * merge into the suffix, and stops at a stable cut once the collected rows
   * project to the requested page size (chunk-heavy logs pack many rows per
   * item, so a stable cut can sit well below `limit` projected items). The
   * first batch has no seq bound, so it covers the file. Returns null when
   * the scan exceeds the cap so the caller falls back to the full read.
   */
  private async fetchCommittedTail(
    agentId: string,
    limit: number,
  ): Promise<AgentTimelineFetchResult | null> {
    const collected: AgentTimelineRow[] = [];
    const collectedIdentities = new Set<string>();
    let offset = 0;
    let reachedStart = false;
    for (;;) {
      const batch = await this.readTailRows(agentId, {
        offset,
        count: TIMELINE_TAIL_BACKFILL_BATCH_ROWS,
      });
      if (batch.rows.length === 0) {
        reachedStart = true;
        break;
      }
      if (collected.length + batch.rows.length > TIMELINE_TAIL_BACKFILL_MAX_SCAN_ROWS) return null;
      offset += batch.rows.length;
      collected.unshift(...batch.rows);
      for (const row of batch.rows) {
        const identity = timelineItemIdentity(row.item);
        if (identity !== null) collectedIdentities.add(identity);
      }
      if (batch.atStart) {
        reachedStart = true;
        break;
      }
      const collectionOldest = collected[0];
      const probe = await this.readTailRows(agentId, {
        maxSeq: collectionOldest.seq - 1,
        offset: 0,
        count: 1,
      });
      if (probe.rows.length === 0) {
        reachedStart = true;
        break;
      }
      if (
        tailBoundaryRowCrosses({
          probe: probe.rows[0],
          collectionOldest,
          collectedIdentities,
        })
      ) {
        continue;
      }
      // A stable cut keeps the collected entries final, but the page is only
      // complete once the collected rows project to at least `limit` items:
      // chunk-heavy history packs many rows per item, and stopping at the
      // first cut would serve a short page while older items remain.
      if (projectTimelineRows({ rows: collected, mode: "projected" }).length >= limit) break;
    }

    const projected = projectTimelineRows({ rows: collected, mode: "projected" });
    const minSeq = collected.length > 0 ? collected[0].seq : 0;
    const maxSeq = collected.length > 0 ? collected[collected.length - 1].seq : 0;
    if (projected.length === 0) {
      return {
        epoch: "",
        direction: "tail",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 1 },
        hasOlder: false,
        hasNewer: false,
        startSeq: null,
        endSeq: null,
        rows: [],
      };
    }
    const selection = selectProjectedEntriesTail(projected, limit, { minSeq, maxSeq });
    return {
      epoch: "",
      direction: "tail",
      reset: false,
      staleCursor: false,
      gap: false,
      window: { minSeq, maxSeq, nextSeq: maxSeq + 1 },
      // Rows may exist above a stability cut that did not reach the log start.
      hasOlder: selection.hasOlder || !reachedStart,
      hasNewer: false,
      startSeq: selection.startSeq,
      endSeq: selection.endSeq,
      rows: selection.entries.map((entry) => Object.assign({ seq: entry.seqEnd }, entry)),
    };
  }

  async readTailRows(
    agentId: string,
    options: { maxSeq?: number; offset: number; count: number },
  ): Promise<AgentTimelineTailRead> {
    const target = options.offset + options.count;
    if (target === 0) return { rows: [], atStart: true };
    // A maxSeq of zero or less excludes every row (seqs start at 1).
    if (options.maxSeq !== undefined && options.maxSeq <= 0) return { rows: [], atStart: true };
    let size: number;
    try {
      size = (await stat(this.filePath(agentId))).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], atStart: true };
      throw error;
    }
    if (size === 0) return { rows: [], atStart: true };

    // Grow a tail buffer (256KB, 512KB, ...) and parse every complete line in
    // it. A retry or enrichment flush can re-append old rows after the
    // newest mints, so the tail of the file no longer reflects seq order and
    // stopping at the first `target` distinct seqs can return rows from the
    // middle of the log. Without a maxSeq bound the file's newest seq is
    // unknowable from a suffix alone, so the buffer must cover the file;
    // with a bound, the buffer certifies the newest `target` seqs once it
    // holds the row for maxSeq and every seq down to the cutoff — each of
    // those seqs then has a line in the buffer, so its newest line sits in
    // the buffer too.
    const chunk = 256 * 1024;
    let length = 0;
    let coversFile = false;
    let eligible: AgentTimelineRow[] = [];
    let bySeq = new Map<number, AgentTimelineRow>();
    for (;;) {
      length = Math.min(size, length === 0 ? chunk : length * 2);
      coversFile = length >= size;
      const contents = await this.readTail(agentId, size, length);
      // Drop everything before the first newline only when the buffer does
      // not start at the file start: at a shorter buffer the oldest line is
      // cut mid-line (or mid-UTF-8 character) and can never parse. A buffer
      // that covers the file starts on a line boundary.
      const firstNewline = contents.indexOf("\n");
      const scoped = coversFile || firstNewline < 0 ? contents : contents.slice(firstNewline + 1);
      const lines = scoped.split("\n");

      bySeq = FileAgentTimelineStore.parseTailLines(lines, options.maxSeq);
      eligible = [...bySeq.values()].sort((a, b) => b.seq - a.seq); // newest first
      if (coversFile) break;
      if (
        options.maxSeq !== undefined &&
        FileAgentTimelineStore.certifiesNewest(bySeq, eligible, target, options.maxSeq)
      ) {
        break;
      }
    }

    const slice = eligible.slice(options.offset, options.offset + options.count);
    // atStart means "no eligible rows remain below the returned range". Exact
    // when the buffer covers the file. A certified range that starts at seq 1
    // is the whole eligible set; otherwise rows below are unknowable.
    const certified =
      options.maxSeq !== undefined &&
      FileAgentTimelineStore.certifiesNewest(bySeq, eligible, target, options.maxSeq);
    return {
      rows: [...slice].toReversed(),
      atStart: coversFile
        ? eligible.length <= target
        : certified && options.offset === 0 && eligible[target - 1].seq === 1,
    };
  }

  /**
   * Whether the buffer certifies the newest eligible rows: it holds the row
   * for maxSeq (the true newest eligible) and every seq down to the cutoff,
   * so the newest `target` distinct seqs are exactly the buffer's and each
   * sits on its newest line within the buffer.
   */
  private static certifiesNewest(
    bySeq: Map<number, AgentTimelineRow>,
    eligible: readonly AgentTimelineRow[],
    target: number,
    maxSeq: number,
  ): boolean {
    return (
      eligible.length >= target &&
      eligible[0].seq === maxSeq &&
      FileAgentTimelineStore.seqRangePresent(bySeq, eligible[target - 1].seq, maxSeq)
    );
  }

  /**
   * Parse the buffer's complete lines into a bySeq map, last line seen per
   * seq winning (physical append order is newest-first within the buffer).
   */
  private static parseTailLines(
    lines: readonly string[],
    maxSeq: number | undefined,
  ): Map<number, AgentTimelineRow> {
    const bySeq = new Map<number, AgentTimelineRow>();
    for (const line of lines) {
      if (line.length === 0) continue;
      const row = FileAgentTimelineStore.parseRowLine(line);
      if (!row) continue;
      if (maxSeq !== undefined && row.seq > maxSeq) continue;
      bySeq.set(row.seq, row);
    }
    return bySeq;
  }

  /**
   * Whether every seq from `from` to `to` (inclusive) has a line in the
   * buffer's bySeq map.
   */
  private static seqRangePresent(
    bySeq: Map<number, AgentTimelineRow>,
    from: number,
    to: number,
  ): boolean {
    for (let seq = from; seq <= to; seq += 1) {
      if (!bySeq.has(seq)) return false;
    }
    return true;
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const contents = await this.readFile(agentId);
    if (contents === null) return 0;
    // A full parse per line: a torn trailing line must not contribute its seq,
    // and a prefix match alone cannot distinguish a torn line from a complete
    // one. This runs once per agent registration, so the cost is acceptable.
    let maxSeq = 0;
    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;
      const seq = FileAgentTimelineStore.parseRowLine(line)?.seq ?? 0;
      if (seq > maxSeq) maxSeq = seq;
    }
    return maxSeq;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const contents = await this.readFile(agentId);
    if (contents === null) return [];
    const bySeq = new Map<number, AgentTimelineRow>();
    for (const line of contents.split("\n")) {
      if (line.length === 0) continue;
      const row = FileAgentTimelineStore.parseRowLine(line);
      if (row) bySeq.set(row.seq, row);
    }
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  }

  async getLastItem(
    agentId: string,
    options?: { maxSeq?: number },
  ): Promise<AgentTimelineItem | null> {
    const rows = await this.committedRowsUpTo(agentId, options?.maxSeq);
    return rows[rows.length - 1]?.item ?? null;
  }

  async getLastAssistantMessage(
    agentId: string,
    options?: { maxSeq?: number },
  ): Promise<string | null> {
    const rows = await this.committedRowsUpTo(agentId, options?.maxSeq);
    const chunks: string[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const item = rows[i]?.item;
      if (item?.type !== "assistant_message") {
        if (chunks.length > 0) break;
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length > 0 ? chunks.toReversed().join("") : null;
  }

  private async committedRowsUpTo(
    agentId: string,
    maxSeq: number | undefined,
  ): Promise<AgentTimelineRow[]> {
    const rows = await this.getCommittedRows(agentId);
    if (maxSeq === undefined) {
      return rows;
    }
    return rows.filter((row) => row.seq <= maxSeq);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.enqueueWrite(agentId, () => rm(this.filePath(agentId), { force: true }));
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.enqueueWrite(agentId, () =>
      this.appendRowLines(agentId, rows.map(FileAgentTimelineStore.serializeRow)),
    );
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.enqueueWrite(agentId, () =>
      this.appendRowLines(agentId, [FileAgentTimelineStore.serializeRow(row)]),
    );
  }

  private async appendRowLines(agentId: string, lines: readonly string[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await this.ensureTrailingNewline(agentId);
    await appendFile(this.filePath(agentId), lines.join("\n") + "\n", "utf8");
  }

  /**
   * A crash mid-append leaves the newest line unterminated; the next append
   * would concatenate onto it and the combined line would fail to parse,
   * losing the new row and cascading into later writes. Every in-process
   * write ends with a newline, so an unterminated tail means the file was
   * left by a dead process (or modified outside it) — repair it by isolating
   * the torn fragment on its own (unparseable, skipped) line. Runs before
   * every append: writes are batched, so one extra stat per batch is cheap,
   * and a per-agent memo would miss a crash between two writes.
   */
  private async ensureTrailingNewline(agentId: string): Promise<void> {
    const filePath = this.filePath(agentId);
    let handle: FileHandle;
    try {
      handle = await open(filePath, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size === 0) return;
      const last = Buffer.alloc(1);
      const { bytesRead } = await handle.read(last, 0, 1, size - 1);
      if (bytesRead === 1 && last[0] !== 0x0a) {
        await appendFile(filePath, "\n", "utf8");
      }
    } finally {
      await handle.close();
    }
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, `${agentId}.jsonl`);
  }

  private enqueueWrite<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChains.get(agentId) ?? Promise.resolve();
    const run = previous.then(
      () => operation(),
      () => operation(),
    );
    this.writeChains.set(
      agentId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async readFile(agentId: string): Promise<string | null> {
    try {
      return await readFile(this.filePath(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async readTail(agentId: string, size: number, length: number): Promise<string> {
    const handle = await open(this.filePath(agentId), "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, size - length);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  }

  private static serializeRow(row: AgentTimelineRow): string {
    return JSON.stringify({
      seq: row.seq,
      timestamp: row.timestamp,
      item: row.item,
      ...(row.turnId !== undefined ? { turnId: row.turnId } : {}),
      ...(row.providerMessageId !== undefined ? { providerMessageId: row.providerMessageId } : {}),
    });
  }

  private static parseRowLine(line: string): AgentTimelineRow | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return null;
    }
    const result = SavedTimelineRowSchema.safeParse(parsed);
    return result.success ? result.data : null;
  }
}
