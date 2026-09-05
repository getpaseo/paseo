import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import { PagedTimelineCatalog } from "./timeline-cache/paged-catalog.js";
import type { CatalogPageRef } from "./timeline-cache/paged-catalog.js";
import { buildRowSegment, encodeRowSegment, readRowSegment } from "./timeline-cache/row-segment.js";
import type { RowSegment, SegmentDescriptor } from "./timeline-cache/row-segment.js";
import { TimelineSnapshotManager } from "./timeline-cache/snapshot.js";
import type { TimelineManifest } from "./timeline-cache/snapshot.js";

const DEFAULT_MAX_ROWS = 256;
const DEFAULT_MAX_SEGMENT_BYTES = 256 * 1024;
const DEFAULT_CATALOG_FANOUT = 64;
const DEFAULT_MAX_PAGE_BYTES = 64 * 1024;
const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024;
const CATALOG_BATCH = 16;

export interface SegmentedFileAgentTimelineStoreOptions {
  maxRowsPerSegment?: number;
  maxBytesPerSegment?: number;
  catalogFanout?: number;
  maxCatalogPageBytes?: number;
  maxManifestBytes?: number;
  onCatalogPageRead?: (filePath: string) => void;
  onSegmentRead?: (filePath: string) => void;
  onSegmentWrite?: (filePath: string, bytes: number) => void;
  onManifestWrite?: (bytes: number) => void;
  beforeSegmentRead?: (filePath: string) => Promise<void>;
  onMutationLockContention?: () => void;
  writeFileAtomic?: (filePath: string, data: string) => Promise<void>;
}

interface AgentContext {
  directory: string;
  catalog: PagedTimelineCatalog;
  snapshots: TimelineSnapshotManager;
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function fetchLimit(options?: AgentTimelineFetchOptions): number {
  return options?.limit === undefined ? 200 : Math.max(0, Math.floor(options.limit));
}

/** Regenerable, bounded-I/O cache. Provider history remains authoritative. */
export class SegmentedFileAgentTimelineStore implements AgentTimelineStore {
  private readonly maxRows: number;
  private readonly maxSegmentBytes: number;
  private readonly contexts = new Map<string, AgentContext>();
  private readonly mutationTails = new Map<string, Promise<void>>();

  constructor(
    private readonly directory: string,
    private readonly options?: SegmentedFileAgentTimelineStoreOptions,
  ) {
    this.maxRows = options?.maxRowsPerSegment ?? DEFAULT_MAX_ROWS;
    this.maxSegmentBytes = options?.maxBytesPerSegment ?? DEFAULT_MAX_SEGMENT_BYTES;
    if (!Number.isSafeInteger(this.maxRows) || this.maxRows < 1) {
      throw new Error("maxRowsPerSegment must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxSegmentBytes) || this.maxSegmentBytes < 1) {
      throw new Error("maxBytesPerSegment must be a positive safe integer");
    }
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return await this.mutate(agentId, async () => {
      const context = this.context(agentId);
      const lease = await context.snapshots.load();
      try {
        const row: AgentTimelineRow = {
          seq: lease.manifest.nextSeq,
          timestamp: options?.timestamp ?? new Date().toISOString(),
          item: structuredClone(item),
          ...(options?.turnId ? { turnId: options.turnId } : {}),
        };
        await this.appendRow(context, lease.manifest, row);
        return cloneRow(row);
      } finally {
        lease.release();
      }
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const context = this.context(agentId);
    const lease = await context.snapshots.load();
    try {
      const manifest = lease.manifest;
      const direction = options?.direction ?? "tail";
      const limit = fetchLimit(options);
      const cursor = options?.cursor;
      const { rows, staleCursor, gap } = await this.selectFetchRows(
        context,
        manifest,
        direction,
        cursor,
        limit,
      );
      const reset = staleCursor || gap;
      const { hasOlder, hasNewer } = fetchNavigationFlags(
        manifest,
        direction,
        cursor?.seq,
        rows,
        reset,
      );
      return {
        epoch: manifest.epoch,
        direction,
        reset,
        staleCursor,
        gap,
        window: {
          minSeq: manifest.minSeq,
          maxSeq: manifest.maxSeq,
          nextSeq: manifest.nextSeq,
        },
        hasOlder,
        hasNewer,
        rows,
      };
    } finally {
      lease.release();
    }
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const context = this.context(agentId);
    const lease = await context.snapshots.load();
    try {
      if (!lease.manifest.root) return [];
      const rows: AgentTimelineRow[] = [];
      let cursor = lease.manifest.minSeq - 1;
      while (cursor < lease.manifest.maxSeq) {
        const descriptors = await context.catalog.after(lease.manifest.root, cursor, CATALOG_BATCH);
        if (descriptors.length === 0) break;
        for (const descriptor of descriptors) {
          rows.push(...(await this.readSegment(context, descriptor)).rows.map(cloneRow));
        }
        cursor = descriptors.at(-1)!.maxSeq;
      }
      return rows;
    } finally {
      lease.release();
    }
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const lease = await this.context(agentId).snapshots.load();
    try {
      return lease.manifest.maxSeq;
    } finally {
      lease.release();
    }
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const context = this.context(agentId);
    const lease = await context.snapshots.load();
    try {
      if (!lease.manifest.root) return null;
      const descriptor = (
        await context.catalog.before(lease.manifest.root, lease.manifest.nextSeq, 1)
      )[0]!;
      return structuredClone((await this.readSegment(context, descriptor)).rows.at(-1)!.item);
    } finally {
      lease.release();
    }
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const context = this.context(agentId);
    const lease = await context.snapshots.load();
    try {
      const root = lease.manifest.root;
      const address = root?.summary.lastAssistantRun;
      if (!address || !root) return null;
      const chunks: string[] = [];
      let cursor = address.startSeq - 1;
      while (cursor < address.endSeq) {
        const descriptors = await context.catalog.after(root, cursor, CATALOG_BATCH);
        if (descriptors.length === 0) throw new Error("Assistant address is absent from catalog");
        for (const descriptor of descriptors) {
          const segment = await this.readSegment(context, descriptor);
          chunks.push(...assistantChunks(segment, address));
          cursor = descriptor.maxSeq;
          if (cursor >= address.endSeq) break;
        }
      }
      return chunks.join("");
    } finally {
      lease.release();
    }
  }

  async bulkInsert(agentId: string, candidates: readonly AgentTimelineRow[]): Promise<void> {
    // Each row is independently published. Multi-row calls are not atomic by design because this
    // is a regenerable cache; provider history remains the transaction authority.
    await this.mutate(agentId, async () => {
      for (const candidate of candidates) await this.insertCandidate(agentId, cloneRow(candidate));
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.mutate(agentId, async () => {
      const context = this.context(agentId);
      const lease = await context.snapshots.load();
      try {
        const existing = await context.catalog.find(lease.manifest.root, row.seq);
        if (!existing) throw new Error(`Cannot update missing timeline row sequence ${row.seq}`);
        const segment = await this.readSegment(context, existing);
        const index = segment.rows.findIndex((candidate) => candidate.seq === row.seq);
        if (index < 0) throw new Error(`Cannot update missing timeline row sequence ${row.seq}`);
        const replacement = buildRowSegment(segment.rows.with(index, cloneRow(row)));
        await this.publishRoot(context, lease.manifest, async () => {
          const descriptor = await this.writeSegment(
            context,
            lease.manifest.generation + 1,
            replacement,
          );
          return await context.catalog.replace(lease.manifest.root, row.seq, descriptor);
        });
      } finally {
        lease.release();
      }
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.mutate(agentId, async () => {
      await this.context(agentId).snapshots.deleteCache();
      this.contexts.delete(agentId);
    });
  }

  async collectGarbage(agentId: string): Promise<void> {
    // Explicit maintenance keeps first access bounded; GC walks the complete manifest-owned tree.
    await this.context(agentId).snapshots.collectGarbage();
  }

  private async selectFetchRows(
    context: AgentContext,
    manifest: TimelineManifest,
    direction: NonNullable<AgentTimelineFetchOptions["direction"]>,
    cursor: AgentTimelineFetchOptions["cursor"],
    requestedLimit: number,
  ): Promise<{ rows: AgentTimelineRow[]; staleCursor: boolean; gap: boolean }> {
    const limit =
      requestedLimit === 0 ? Math.max(0, manifest.maxSeq - manifest.minSeq + 1) : requestedLimit;
    const staleCursor = cursor?.epoch !== undefined && cursor.epoch !== manifest.epoch;
    const gap =
      !staleCursor &&
      direction === "after" &&
      cursor !== undefined &&
      manifest.root !== null &&
      cursor.seq < manifest.minSeq - 1;
    if (staleCursor || gap) {
      const rows = manifest.root
        ? await this.rowsBefore(context, manifest.root, manifest.nextSeq, limit)
        : [];
      return { rows, staleCursor, gap };
    }
    if (!manifest.root) return { rows: [], staleCursor: false, gap: false };
    if (direction === "tail") {
      return {
        rows: await this.rowsBefore(context, manifest.root, manifest.nextSeq, limit),
        staleCursor: false,
        gap: false,
      };
    }
    const rows =
      direction === "before"
        ? await this.rowsBefore(context, manifest.root, cursor?.seq ?? manifest.nextSeq, limit)
        : await this.rowsAfter(context, manifest.root, cursor?.seq ?? 0, limit);
    return { rows, staleCursor: false, gap: false };
  }

  private async insertCandidate(agentId: string, row: AgentTimelineRow): Promise<void> {
    const context = this.context(agentId);
    const lease = await context.snapshots.load();
    try {
      const descriptor = await context.catalog.find(lease.manifest.root, row.seq);
      if (descriptor) {
        const existing = (await this.readSegment(context, descriptor)).rows.find(
          (candidate) => candidate.seq === row.seq,
        );
        if (!existing || !isDeepStrictEqual(existing, row)) {
          throw new Error(`Conflicting timeline row sequence ${row.seq}`);
        }
        return;
      }
      if (lease.manifest.root && row.seq !== lease.manifest.nextSeq) {
        throw new Error("Timeline inserts must append in increasing sequence order");
      }
      await this.appendRow(context, lease.manifest, row);
    } finally {
      lease.release();
    }
  }

  private async appendRow(
    context: AgentContext,
    manifest: TimelineManifest,
    row: AgentTimelineRow,
  ): Promise<void> {
    await this.publishRoot(context, manifest, async () => {
      const last = manifest.root
        ? (await context.catalog.before(manifest.root, manifest.nextSeq, 1))[0]!
        : null;
      if (last) {
        const current = await this.readSegment(context, last);
        const extended = buildRowSegment([...current.rows, cloneRow(row)]);
        const fits =
          extended.rows.length <= this.maxRows &&
          Buffer.byteLength(JSON.stringify(extended)) <= this.maxSegmentBytes;
        if (fits) {
          const descriptor = await this.writeSegment(context, manifest.generation + 1, extended);
          return await context.catalog.replace(manifest.root, last.minSeq, descriptor);
        }
        const descriptor = await this.writeSegment(
          context,
          manifest.generation + 1,
          buildRowSegment([row]),
        );
        return await context.catalog.append(manifest.root, descriptor);
      }
      const descriptor = await this.writeSegment(
        context,
        manifest.generation + 1,
        buildRowSegment([row]),
      );
      return await context.catalog.append(null, descriptor);
    });
  }

  private async publishRoot(
    context: AgentContext,
    manifest: TimelineManifest,
    buildRoot: () => Promise<CatalogPageRef>,
  ): Promise<void> {
    const next = await context.snapshots.publish(manifest, async () => {
      const root = await buildRoot();
      return {
        epoch: manifest.epoch,
        nextSeq: root.maxSeq + 1,
        minSeq: root.minSeq,
        maxSeq: root.maxSeq,
        root,
      };
    });
    this.options?.onManifestWrite?.(Buffer.byteLength(JSON.stringify(next)));
  }

  private async rowsBefore(
    context: AgentContext,
    root: CatalogPageRef,
    beforeSeq: number,
    limit: number,
  ): Promise<AgentTimelineRow[]> {
    let cursor = beforeSeq;
    const chunks: AgentTimelineRow[][] = [];
    let count = 0;
    while (count < limit) {
      const descriptor = (await context.catalog.before(root, cursor, 1))[0];
      if (!descriptor) break;
      const rows = (await this.readSegment(context, descriptor)).rows
        .filter((row) => row.seq < beforeSeq)
        .map(cloneRow);
      if (rows.length > 0) {
        chunks.push(rows);
        count += rows.length;
      }
      cursor = descriptor.minSeq;
    }
    return chunks.toReversed().flat().slice(-limit);
  }

  private async rowsAfter(
    context: AgentContext,
    root: CatalogPageRef,
    afterSeq: number,
    limit: number,
  ): Promise<AgentTimelineRow[]> {
    const rows: AgentTimelineRow[] = [];
    let cursor = afterSeq;
    while (rows.length < limit) {
      const descriptor = (await context.catalog.after(root, cursor, 1))[0];
      if (!descriptor) break;
      rows.push(
        ...(await this.readSegment(context, descriptor)).rows
          .filter((row) => row.seq > afterSeq)
          .map(cloneRow),
      );
      cursor = descriptor.maxSeq;
    }
    return rows.slice(0, limit);
  }

  private async readSegment(
    context: AgentContext,
    descriptor: SegmentDescriptor,
  ): Promise<RowSegment> {
    const filePath = path.join(context.directory, descriptor.file);
    this.options?.onSegmentRead?.(filePath);
    await this.options?.beforeSegmentRead?.(filePath);
    let segment: RowSegment;
    try {
      segment = await readRowSegment(filePath, this.maxSegmentBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`Corrupt timeline cache: missing segment '${descriptor.file}'`, {
          cause: error,
        });
      }
      throw error;
    }
    if (
      segment.summary.minSeq !== descriptor.minSeq ||
      segment.summary.maxSeq !== descriptor.maxSeq ||
      !isDeepStrictEqual(segment.summary, descriptor.summary)
    ) {
      throw new Error("Timeline segment does not match its catalog descriptor");
    }
    return segment;
  }

  private async writeSegment(
    context: AgentContext,
    generation: number,
    segment: RowSegment,
  ): Promise<SegmentDescriptor> {
    if (segment.rows.length > this.maxRows) throw new Error("Timeline segment exceeds row limit");
    const text = encodeRowSegment(segment, this.maxSegmentBytes);
    const file = `segment-${generation}-${randomUUID()}.json`;
    const filePath = path.join(context.directory, file);
    await (this.options?.writeFileAtomic ?? writeFileAtomic)(filePath, text);
    this.options?.onSegmentWrite?.(filePath, Buffer.byteLength(text));
    return {
      file,
      generation,
      minSeq: segment.summary.minSeq,
      maxSeq: segment.summary.maxSeq,
      summary: segment.summary,
    };
  }

  private context(agentId: string): AgentContext {
    const cached = this.contexts.get(agentId);
    if (cached) return cached;
    const directory = this.agentDirectory(agentId);
    const catalog = new PagedTimelineCatalog(directory, {
      fanout: this.options?.catalogFanout ?? DEFAULT_CATALOG_FANOUT,
      maxPageBytes: this.options?.maxCatalogPageBytes ?? DEFAULT_MAX_PAGE_BYTES,
      onPageRead: this.options?.onCatalogPageRead,
      writeFileAtomic: this.options?.writeFileAtomic,
    });
    const context = {
      directory,
      catalog,
      snapshots: new TimelineSnapshotManager(directory, catalog, {
        maxManifestBytes: this.options?.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES,
        writeFileAtomic: this.options?.writeFileAtomic,
        mutationLock: { onContention: this.options?.onMutationLockContention },
      }),
    };
    this.contexts.set(agentId, context);
    return context;
  }

  private async mutate<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTails.get(agentId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationTails.set(agentId, tail);
    void tail.finally(() => {
      if (this.mutationTails.get(agentId) === tail) this.mutationTails.delete(agentId);
    });
    return await result;
  }

  private agentDirectory(agentId: string): string {
    return path.join(this.directory, `agent-${Buffer.from(agentId, "utf8").toString("base64url")}`);
  }
}

function assistantChunks(
  segment: RowSegment,
  address: { startSeq: number; endSeq: number },
): string[] {
  return segment.rows
    .filter((row) => address.startSeq <= row.seq && row.seq <= address.endSeq)
    .map((row) => {
      if (row.item.type !== "assistant_message") {
        throw new Error("Assistant address contains a non-assistant row");
      }
      return row.item.text;
    });
}

function fetchNavigationFlags(
  manifest: TimelineManifest,
  direction: NonNullable<AgentTimelineFetchOptions["direction"]>,
  cursorSeq: number | undefined,
  rows: readonly AgentTimelineRow[],
  reset: boolean,
): { hasOlder: boolean; hasNewer: boolean } {
  let hasOlder = rows.length > 0 && rows[0]!.seq > manifest.minSeq;
  let hasNewer = false;
  if (!reset && direction === "after") {
    if (rows.length === 0) hasOlder = (cursorSeq ?? 0) >= manifest.minSeq && manifest.root !== null;
    hasNewer = rows.length > 0 && rows.at(-1)!.seq < manifest.maxSeq;
  } else if (!reset && direction === "before") {
    hasNewer = manifest.root !== null && (cursorSeq ?? manifest.nextSeq) <= manifest.maxSeq;
  }
  return { hasOlder, hasNewer };
}
