import type { AgentTimelineItem } from "./agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import {
  BoundedAgentTimelineHotStore,
  type BoundedAgentTimelineHotStoreOptions,
  type HotTimelineMetrics,
  type HotTimelineRowOptions,
  type HotTimelineRevision,
  type HotTimelineSnapshot,
} from "./bounded-agent-timeline-hot-store.js";
import {
  OrderedAgentTimelineDurableBuffer,
  DEFAULT_TIMELINE_DURABLE_MAX_ROW_BYTES,
  TimelineDurableBufferBackpressureError,
  type OrderedAgentTimelineDurableBufferOptions,
  type TimelineDurableBufferMetrics,
  type TimelineDurableSink,
} from "./ordered-agent-timeline-durable-buffer.js";

const DEFAULT_FETCH_LIMIT = 200;

export interface BoundedAgentTimelineRuntimeOptions {
  hot: BoundedAgentTimelineHotStoreOptions;
  buffer?: OrderedAgentTimelineDurableBufferOptions;
  durableSink?: TimelineDurableSink;
  onHotChanged?: (agentId: string, snapshot: HotTimelineSnapshot) => void;
}

export interface BoundedAgentTimelineRuntimeMetrics {
  hot: HotTimelineMetrics;
  buffer: TimelineDurableBufferMetrics;
  durabilityError: unknown;
}

export interface BoundedAgentTimelineRuntimeAggregateMetrics {
  residentRows: number;
  residentBytes: number;
  pendingRows: number;
  pendingBytes: number;
  backpressuredAgents: number;
  failedAgents: number;
}

interface MutationState {
  completions: Set<Promise<void>>;
}

type RuntimeLifecycle = "initializing" | "active" | "releasing" | "delete_failed";

/**
 * Root-agent timeline cache. Provider history remains authoritative; the segmented store is a
 * disposable paging cache, while the hot store owns the synchronous live tail and pending rows.
 */
export class BoundedAgentTimelineRuntime {
  private readonly hot: BoundedAgentTimelineHotStore;
  private readonly buffer: OrderedAgentTimelineDurableBuffer;
  private readonly onHotChanged?: BoundedAgentTimelineRuntimeOptions["onHotChanged"];
  private readonly mutations = new Map<string, MutationState>();
  private readonly durabilityErrors = new Map<string, unknown>();
  private readonly agentIds = new Set<string>();
  private readonly lifecycle = new Map<string, RuntimeLifecycle>();
  private readonly generationTokens = new Map<string, object>();
  private readonly initializations = new Map<string, Promise<void>>();

  constructor(
    private readonly durable: AgentTimelineStore,
    options: BoundedAgentTimelineRuntimeOptions,
  ) {
    this.hot = new BoundedAgentTimelineHotStore(options.hot);
    this.onHotChanged = options.onHotChanged;
    const callerOnDurable = options.buffer?.onDurable;
    const maxBatchBytes = options.buffer?.maxBatchBytes ?? Number.POSITIVE_INFINITY;
    const maxPendingBytes = options.buffer?.maxPendingBytes ?? Number.POSITIVE_INFINITY;
    const maxRowBytes =
      options.buffer?.maxRowBytes ??
      Math.min(
        DEFAULT_TIMELINE_DURABLE_MAX_ROW_BYTES,
        options.hot.maxBytes,
        maxBatchBytes,
        maxPendingBytes,
      );
    if (maxRowBytes > options.hot.maxBytes) {
      throw new Error("maxRowBytes must not exceed the hot timeline maxBytes");
    }
    this.buffer = new OrderedAgentTimelineDurableBuffer(options.durableSink ?? durable, {
      ...options.buffer,
      maxRowBytes,
      onDurable: (acknowledgement) => {
        for (const revision of acknowledgement.revisions) {
          if (revision) this.hot.acknowledgeDurable(acknowledgement.agentId, revision);
        }
        this.publishHotChanged(acknowledgement.agentId);
        callerOnDurable?.(acknowledgement);
      },
    });
  }

  initialize(agentId: string): Promise<void> {
    const existing = this.initializations.get(agentId);
    if (existing) return existing;
    const lifecycle = this.lifecycle.get(agentId);
    if (lifecycle === "active") return Promise.resolve();
    if (lifecycle === "initializing") {
      return Promise.reject(new Error(`Timeline runtime is still initializing agent '${agentId}'`));
    }
    if (lifecycle === "releasing") {
      return Promise.reject(new Error(`Timeline runtime is still releasing agent '${agentId}'`));
    }
    if (lifecycle === "delete_failed") {
      return Promise.reject(
        new Error(`Timeline runtime cache deletion must be retried for agent '${agentId}'`),
      );
    }
    this.lifecycle.set(agentId, "initializing");
    this.generationTokens.set(agentId, {});
    const initialization = this.initializeOnce(agentId)
      .catch((error: unknown) => {
        if (this.lifecycle.get(agentId) === "initializing") this.clearResidentState(agentId);
        throw error;
      })
      .finally(() => {
        if (this.initializations.get(agentId) === initialization) {
          this.initializations.delete(agentId);
        }
      });
    this.initializations.set(agentId, initialization);
    return initialization;
  }

  private async initializeOnce(agentId: string): Promise<void> {
    const durable = await this.durable.fetchCommitted(agentId, { direction: "tail" });
    this.hot.initialize(agentId, {
      epoch: durable.epoch,
      window: durable.window,
      rows: durable.rows,
    });
    this.agentIds.add(agentId);
    this.lifecycle.set(agentId, "active");
    this.durabilityErrors.delete(agentId);
    this.publishHotChanged(agentId);
  }

  has(agentId: string): boolean {
    return this.lifecycle.get(agentId) === "active" && this.hot.has(agentId);
  }

  append(
    agentId: string,
    row: AgentTimelineRow,
    options?: HotTimelineRowOptions,
  ): HotTimelineRevision {
    this.assertActive(agentId);
    const reservation = this.buffer.reserveInsertOrThrow(agentId, row);
    try {
      const revision = this.hot.append(agentId, row, options);
      this.publishHotChanged(agentId);
      this.observeCompletion(agentId, reservation.commit(revision));
      return revision;
    } catch (error) {
      reservation.cancel();
      throw error;
    }
  }

  appendItem(
    agentId: string,
    item: AgentTimelineItem,
    options?: {
      timestamp?: string;
      providerMessageId?: string;
      turnId?: string;
      mutable?: boolean;
    },
  ): AgentTimelineRow {
    const nextSeq = this.hot.snapshot(agentId).logicalWindow.nextSeq;
    const row: AgentTimelineRow = {
      seq: nextSeq,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item: structuredClone(item),
      ...(options?.providerMessageId ? { providerMessageId: options.providerMessageId } : {}),
      ...(options?.turnId ? { turnId: options.turnId } : {}),
    };
    this.append(agentId, row, { mutable: options?.mutable });
    return row;
  }

  async appendWhenWritable(
    agentId: string,
    row: AgentTimelineRow,
    options?: HotTimelineRowOptions,
  ): Promise<HotTimelineRevision> {
    const generation = this.requireGeneration(agentId);
    while (true) {
      try {
        return this.append(agentId, row, options);
      } catch (error) {
        if (!(error instanceof TimelineDurableBufferBackpressureError)) throw error;
        await error.whenWritable;
        this.assertGeneration(agentId, generation);
      }
    }
  }

  async appendItemWhenWritable(
    agentId: string,
    item: AgentTimelineItem,
    options?: {
      timestamp?: string;
      providerMessageId?: string;
      turnId?: string;
      mutable?: boolean;
    },
  ): Promise<AgentTimelineRow> {
    const timestamp = options?.timestamp ?? new Date().toISOString();
    const generation = this.requireGeneration(agentId);
    while (true) {
      try {
        return this.appendItem(agentId, item, { ...options, timestamp });
      } catch (error) {
        if (!(error instanceof TimelineDurableBufferBackpressureError)) throw error;
        await error.whenWritable;
        this.assertGeneration(agentId, generation);
      }
    }
  }

  update(
    agentId: string,
    row: AgentTimelineRow,
    options?: HotTimelineRowOptions,
  ): HotTimelineRevision {
    this.assertActive(agentId);
    const reservation = this.buffer.reserveUpdateOrThrow(agentId, row);
    try {
      const revision = this.hot.update(agentId, row, options);
      this.publishHotChanged(agentId);
      this.observeCompletion(agentId, reservation.commit(revision));
      return revision;
    } catch (error) {
      reservation.cancel();
      throw error;
    }
  }

  async updateWhenWritable(
    agentId: string,
    row: AgentTimelineRow,
    options?: HotTimelineRowOptions,
  ): Promise<HotTimelineRevision> {
    const generation = this.requireGeneration(agentId);
    while (true) {
      try {
        return this.update(agentId, row, options);
      } catch (error) {
        if (!(error instanceof TimelineDurableBufferBackpressureError)) throw error;
        await error.whenWritable;
        this.assertGeneration(agentId, generation);
      }
    }
  }

  getHotRows(agentId: string): AgentTimelineRow[] {
    return this.hot.snapshot(agentId).rows;
  }

  getHotItems(agentId: string): AgentTimelineItem[] {
    return this.getHotRows(agentId).map(({ item }) => item);
  }

  getEpoch(agentId: string): string {
    return this.hot.snapshot(agentId).epoch;
  }

  getLastHotItem(agentId: string): AgentTimelineItem | null {
    return this.getHotRows(agentId).at(-1)?.item ?? null;
  }

  metrics(agentId: string): BoundedAgentTimelineRuntimeMetrics {
    return {
      hot: this.hot.metrics(agentId),
      buffer: this.buffer.metrics(agentId),
      durabilityError: this.durabilityErrors.get(agentId) ?? null,
    };
  }

  aggregateMetrics(): BoundedAgentTimelineRuntimeAggregateMetrics {
    let residentRows = 0;
    let residentBytes = 0;
    for (const agentId of this.agentIds) {
      const metrics = this.hot.metrics(agentId);
      residentRows += metrics.retainedRows;
      residentBytes += metrics.retainedBytes;
    }
    const buffer = this.buffer.metrics();
    const failedRuntimeAgentIds = new Set(this.durabilityErrors.keys());
    for (const [agentId, lifecycle] of this.lifecycle) {
      if (lifecycle === "delete_failed") failedRuntimeAgentIds.add(agentId);
    }
    return {
      residentRows,
      residentBytes,
      pendingRows: buffer.pendingRows,
      pendingBytes: buffer.pendingBytes,
      backpressuredAgents: buffer.writableSignals,
      failedAgents: Math.max(buffer.failedAgents, failedRuntimeAgentIds.size),
    };
  }

  async fetch(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const generation = this.requireGeneration(agentId);
    while (true) {
      const direction = options?.direction ?? "tail";
      const limit = normalizeLimit(options?.limit);
      const cursor = options?.cursor;
      const { version: initialHotVersion, snapshot: initialHot } =
        this.hot.versionedSnapshot(agentId);
      const expandedLimit = limit === 0 ? 0 : limit + initialHot.rows.length;
      let durable = await this.durable.fetchCommitted(agentId, {
        direction,
        ...(direction !== "tail" && cursor ? { cursor } : {}),
        limit: expandedLimit,
      });
      this.assertGeneration(agentId, generation);
      const hot = this.hot.snapshot(agentId);
      const { staleCursor, gap } = classifyCursor(hot, direction, cursor);
      const reset = staleCursor || gap;
      const effectiveDirection = reset ? "tail" : direction;
      if (reset && direction !== "tail") {
        durable = await this.durable.fetchCommitted(agentId, {
          direction: "tail",
          limit: limit === 0 ? 0 : limit + hot.rows.length,
        });
        this.assertGeneration(agentId, generation);
      }
      if (this.hot.getVersion(agentId) !== initialHotVersion) continue;
      const rowsBySeq = new Map(durable.rows.map((row) => [row.seq, cloneRow(row)]));
      for (const row of hot.rows) rowsBySeq.set(row.seq, cloneRow(row));
      const candidates = [...rowsBySeq.values()].sort((left, right) => left.seq - right.seq);
      const selected = selectRows(candidates, effectiveDirection, cursor?.seq, limit);
      const firstSeq = selected[0]?.seq;
      const lastSeq = selected.at(-1)?.seq;
      const navigation = mergedNavigationFlags(
        hot,
        effectiveDirection,
        cursor?.seq,
        firstSeq,
        lastSeq,
      );
      return {
        epoch: hot.epoch,
        direction,
        reset,
        staleCursor,
        gap,
        window: hot.logicalWindow,
        ...navigation,
        rows: selected,
      };
    }
  }

  async getRows(agentId: string): Promise<AgentTimelineRow[]> {
    return (await this.fetch(agentId, { direction: "tail", limit: 0 })).rows;
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const generation = this.requireGeneration(agentId);
    const hot = this.hot.snapshot(agentId).rows.at(-1);
    const durableSeq = await this.durable.getLatestCommittedSeq(agentId);
    this.assertGeneration(agentId, generation);
    if (hot && hot.seq >= durableSeq) return structuredClone(hot.item);
    const item = await this.durable.getLastItem(agentId);
    this.assertGeneration(agentId, generation);
    return item;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const generation = this.requireGeneration(agentId);
    while (true) {
      const durableSeq = await this.durable.getLatestCommittedSeq(agentId);
      this.assertGeneration(agentId, generation);
      const pendingRows = this.hot.getPendingRows(agentId).filter(({ seq }) => seq >= durableSeq);
      const segment = trailingAssistantSegment(pendingRows.map(({ item }) => item));
      let result: string | null;
      if (!segment) {
        result = await this.durable.getLastAssistantMessage(agentId);
      } else if (!segment.startsAtBeginning || pendingRows[0]?.seq === durableSeq) {
        result = segment.text;
      } else {
        const durableLast = await this.durable.getLastItem(agentId);
        const durableMessage =
          durableLast?.type === "assistant_message"
            ? await this.durable.getLastAssistantMessage(agentId)
            : null;
        result = durableMessage ? `${durableMessage}${segment.text}` : segment.text;
      }
      const latestSeq = await this.durable.getLatestCommittedSeq(agentId);
      this.assertGeneration(agentId, generation);
      if (latestSeq === durableSeq) return result;
    }
  }

  async flush(agentId: string): Promise<void> {
    const state = this.mutations.get(agentId);
    if (state) await Promise.all(state.completions);
    await this.buffer.flush(agentId);
    const error = this.durabilityErrors.get(agentId);
    if (error) throw error;
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.agentIds].map(async (agentId) => await this.flush(agentId)));
  }

  async discardAndDelete(agentId: string): Promise<void> {
    this.beginDelete(agentId);
    try {
      await this.buffer.discard(agentId);
      await this.durable.deleteAgent(agentId);
      await this.buffer.reset(agentId);
      this.clearResidentState(agentId);
    } catch (error) {
      this.lifecycle.set(agentId, "delete_failed");
      throw error;
    }
  }

  async release(agentId: string): Promise<void> {
    this.beginRelease(agentId);
    let failure: unknown;
    try {
      await this.flush(agentId);
    } catch (error) {
      failure = error;
      await this.buffer.discard(agentId);
      await this.buffer.reset(agentId);
      try {
        await this.durable.deleteAgent(agentId);
      } catch (deleteError) {
        this.lifecycle.set(agentId, "delete_failed");
        failure = new AggregateError(
          [error, deleteError],
          `Failed to flush and invalidate timeline cache for agent '${agentId}'`,
        );
      }
    }
    if (this.lifecycle.get(agentId) !== "delete_failed") this.clearResidentState(agentId);
    if (failure !== undefined) throw failure;
  }

  async discardResident(agentId: string): Promise<void> {
    this.beginRelease(agentId);
    await this.buffer.discard(agentId);
    await this.buffer.reset(agentId);
    this.clearResidentState(agentId);
  }

  unpinMutableRows(agentId: string, turnId: string | undefined): void {
    this.assertActive(agentId);
    this.hot.unpinMutableRows(agentId, turnId);
    this.publishHotChanged(agentId);
  }

  private beginRelease(agentId: string): void {
    this.assertActive(agentId);
    this.lifecycle.set(agentId, "releasing");
    this.generationTokens.delete(agentId);
  }

  private beginDelete(agentId: string): void {
    const lifecycle = this.lifecycle.get(agentId);
    if (lifecycle !== undefined && lifecycle !== "active" && lifecycle !== "delete_failed") {
      throw new Error(`Timeline runtime is not accepting deletion for agent '${agentId}'`);
    }
    this.lifecycle.set(agentId, "releasing");
    this.generationTokens.delete(agentId);
  }

  private clearResidentState(agentId: string): void {
    this.mutations.delete(agentId);
    this.durabilityErrors.delete(agentId);
    this.hot.deleteAgent(agentId);
    this.agentIds.delete(agentId);
    this.lifecycle.delete(agentId);
    this.generationTokens.delete(agentId);
  }

  private assertActive(agentId: string): void {
    if (this.lifecycle.get(agentId) !== "active") {
      throw new Error(`Timeline runtime is not accepting writes for agent '${agentId}'`);
    }
  }

  private requireGeneration(agentId: string): object {
    this.assertActive(agentId);
    return this.generationTokens.get(agentId)!;
  }

  private assertGeneration(agentId: string, generation: object): void {
    if (this.generationTokens.get(agentId) !== generation) {
      throw new Error(`Timeline runtime generation changed for agent '${agentId}'`);
    }
    this.assertActive(agentId);
  }

  private observeCompletion(agentId: string, completion: Promise<void>): void {
    let state = this.mutations.get(agentId);
    if (!state) {
      state = { completions: new Set() };
      this.mutations.set(agentId, state);
    }
    const observed = completion
      .catch((error: unknown) => {
        this.durabilityErrors.set(agentId, error);
      })
      .finally(() => {
        state!.completions.delete(observed);
        if (state!.completions.size === 0) this.mutations.delete(agentId);
      });
    state.completions.add(observed);
  }

  private publishHotChanged(agentId: string): void {
    this.onHotChanged?.(agentId, this.hot.snapshot(agentId));
  }
}

function normalizeLimit(limit: number | undefined): number {
  return limit === undefined ? DEFAULT_FETCH_LIMIT : Math.max(0, Math.floor(limit));
}

function selectRows(
  rows: readonly AgentTimelineRow[],
  direction: "tail" | "before" | "after",
  cursorSeq: number | undefined,
  limit: number,
): AgentTimelineRow[] {
  let candidates = [...rows];
  if (direction === "before" && cursorSeq !== undefined) {
    candidates = rows.filter(({ seq }) => seq < cursorSeq);
  } else if (direction === "after" && cursorSeq !== undefined) {
    candidates = rows.filter(({ seq }) => seq > cursorSeq);
  }
  let selected = candidates;
  if (limit > 0 && candidates.length > limit) {
    selected = direction === "after" ? candidates.slice(0, limit) : candidates.slice(-limit);
  }
  return selected.map(cloneRow);
}

function classifyCursor(
  hot: HotTimelineSnapshot,
  direction: AgentTimelineFetchOptions["direction"],
  cursor: AgentTimelineFetchOptions["cursor"],
): { staleCursor: boolean; gap: boolean } {
  const staleCursor = cursor !== undefined && cursor.epoch !== hot.epoch;
  const gap =
    !staleCursor &&
    direction === "after" &&
    cursor !== undefined &&
    hot.logicalWindow.minSeq > 0 &&
    cursor.seq < hot.logicalWindow.minSeq - 1;
  return { staleCursor, gap };
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function mergedNavigationFlags(
  hot: HotTimelineSnapshot,
  direction: "tail" | "before" | "after",
  cursorSeq: number | undefined,
  firstSeq: number | undefined,
  lastSeq: number | undefined,
): { hasOlder: boolean; hasNewer: boolean } {
  return {
    hasOlder:
      firstSeq !== undefined
        ? firstSeq > hot.logicalWindow.minSeq
        : direction === "after" &&
          (cursorSeq ?? 0) >= hot.logicalWindow.minSeq &&
          hot.logicalWindow.maxSeq > 0,
    hasNewer:
      lastSeq !== undefined
        ? lastSeq < hot.logicalWindow.maxSeq
        : direction === "before" &&
          (cursorSeq ?? hot.logicalWindow.nextSeq) <= hot.logicalWindow.maxSeq,
  };
}

function trailingAssistantSegment(
  items: readonly AgentTimelineItem[],
): { text: string; startsAtBeginning: boolean } | null {
  const chunks: string[] = [];
  let startsAtBeginning = false;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!;
    if (item.type !== "assistant_message") {
      if (chunks.length > 0) break;
      continue;
    }
    chunks.push(item.text);
    startsAtBeginning = index === 0;
  }
  return chunks.length > 0 ? { text: chunks.toReversed().join(""), startsAtBeginning } : null;
}
