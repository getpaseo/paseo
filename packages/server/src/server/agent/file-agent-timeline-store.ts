import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import type { Logger } from "pino";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

interface PersistedAgentTimeline {
  version: 1;
  epoch: string;
  rows: AgentTimelineRow[];
}

export interface FileAgentTimelineStoreOptions {
  epochFactory?: () => string;
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return structuredClone(row);
}

function normalizeRows(rows: readonly AgentTimelineRow[]): AgentTimelineRow[] {
  const normalized = rows.map(cloneRow).sort((left, right) => left.seq - right.seq);
  let previousSeq = 0;
  for (const row of normalized) {
    if (!Number.isSafeInteger(row.seq) || row.seq <= 0 || row.seq === previousSeq) {
      throw new Error(`Invalid or duplicate timeline sequence ${row.seq}`);
    }
    if (typeof row.timestamp !== "string" || row.timestamp.length === 0) {
      throw new Error(`Timeline row ${row.seq} has no timestamp`);
    }
    if (
      typeof row.item !== "object" ||
      row.item === null ||
      typeof (row.item as { type?: unknown }).type !== "string"
    ) {
      throw new Error(`Timeline row ${row.seq} has an invalid item`);
    }
    previousSeq = row.seq;
  }
  return normalized;
}

function parsePersistedTimeline(value: unknown): PersistedAgentTimeline {
  if (typeof value !== "object" || value === null) {
    throw new Error("Timeline file must contain an object");
  }
  const candidate = value as { version?: unknown; epoch?: unknown; rows?: unknown };
  if (candidate.version !== 1) {
    throw new Error("Unsupported timeline file version");
  }
  if (typeof candidate.epoch !== "string" || candidate.epoch.length === 0) {
    throw new Error("Timeline file has no epoch");
  }
  if (!Array.isArray(candidate.rows)) {
    throw new Error("Timeline file has no rows array");
  }
  return {
    version: 1,
    epoch: candidate.epoch,
    rows: normalizeRows(candidate.rows as AgentTimelineRow[]),
  };
}

/**
 * Persists each canonical agent timeline together with its incarnation epoch.
 * Deleting one timeline retires both its rows and epoch, so the next history
 * incarnation cannot inherit a checkpoint from the previous one.
 */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly states = new Map<string, PersistedAgentTimeline>();
  private readonly loadPromises = new Map<string, Promise<PersistedAgentTimeline>>();
  private readonly operationTails = new Map<string, Promise<void>>();
  private readonly logger: Logger;
  private readonly epochFactory: () => string;

  constructor(
    private readonly baseDir: string,
    logger: Logger,
    options?: FileAgentTimelineStoreOptions,
  ) {
    this.logger = logger.child({ module: "agent", component: "file-agent-timeline-store" });
    this.epochFactory = options?.epochFactory ?? randomUUID;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string },
  ): Promise<AgentTimelineRow> {
    return await this.queueMutation(agentId, (current) => {
      const row: AgentTimelineRow = {
        seq: (current.rows.at(-1)?.seq ?? 0) + 1,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item: structuredClone(item),
      };
      return {
        next: { ...current, rows: [...current.rows, row] },
        result: cloneRow(row),
      };
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const state = await this.readState(agentId);
    const store = new InMemoryAgentTimelineStore();
    store.initialize(agentId, {
      epoch: state.epoch,
      rows: state.rows,
      nextSeq: (state.rows.at(-1)?.seq ?? 0) + 1,
    });
    return store.fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const state = await this.readState(agentId);
    return state.rows.at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const state = await this.readState(agentId);
    return state.rows.map(cloneRow);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const state = await this.readState(agentId);
    const item = state.rows.at(-1)?.item;
    return item ? structuredClone(item) : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const state = await this.readState(agentId);
    const chunks: string[] = [];
    for (let index = state.rows.length - 1; index >= 0; index -= 1) {
      const item = state.rows[index]?.item;
      if (!item || item.type !== "assistant_message") {
        if (chunks.length > 0) {
          break;
        }
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length > 0 ? chunks.toReversed().join("") : null;
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.queueOperation(agentId, async () => {
      try {
        await fs.unlink(this.filePath(agentId));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      this.states.delete(agentId);
      this.loadPromises.delete(agentId);
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const incoming = normalizeRows(rows);
    await this.queueMutation(agentId, (current) => {
      const merged = new Map(current.rows.map((row) => [row.seq, row]));
      for (const row of incoming) {
        merged.set(row.seq, row);
      }
      return {
        next: { ...current, rows: normalizeRows(Array.from(merged.values())) },
        result: undefined,
      };
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.bulkInsert(agentId, [row]);
  }

  private async readState(agentId: string): Promise<PersistedAgentTimeline> {
    await (this.operationTails.get(agentId) ?? Promise.resolve());
    return await this.loadState(agentId);
  }

  private async loadState(agentId: string): Promise<PersistedAgentTimeline> {
    const cached = this.states.get(agentId);
    if (cached) {
      return cached;
    }
    const existingLoad = this.loadPromises.get(agentId);
    if (existingLoad) {
      return await existingLoad;
    }
    const load = this.loadStateFromDisk(agentId).finally(() => {
      if (this.loadPromises.get(agentId) === load) {
        this.loadPromises.delete(agentId);
      }
    });
    this.loadPromises.set(agentId, load);
    return await load;
  }

  private async loadStateFromDisk(agentId: string): Promise<PersistedAgentTimeline> {
    const filePath = this.filePath(agentId);
    let state: PersistedAgentTimeline;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      state = parsePersistedTimeline(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.error({ err: error, agentId, filePath }, "Failed to load agent timeline");
        throw error;
      }
      state = { version: 1, epoch: this.epochFactory(), rows: [] };
      // The empty incarnation is authoritative too. Persist it before exposing
      // its epoch so a restart before the first row cannot silently mint another.
      await writeJsonFileAtomic(filePath, state);
    }
    this.states.set(agentId, state);
    return state;
  }

  private async queueMutation<T>(
    agentId: string,
    mutate: (
      current: PersistedAgentTimeline,
    ) =>
      | { next: PersistedAgentTimeline; result: T }
      | Promise<{ next: PersistedAgentTimeline; result: T }>,
  ): Promise<T> {
    return await this.queueOperation(agentId, async () => {
      const current = await this.loadState(agentId);
      const { next, result } = await mutate(current);
      await writeJsonFileAtomic(this.filePath(agentId), next);
      this.states.set(agentId, next);
      return result;
    });
  }

  private queueOperation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTails.get(agentId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.operationTails.set(agentId, settled);
    void settled.then(() => {
      if (this.operationTails.get(agentId) === settled) {
        this.operationTails.delete(agentId);
      }
      return undefined;
    });
    return current;
  }

  private filePath(agentId: string): string {
    return path.join(this.baseDir, `agent-${Buffer.from(agentId).toString("base64url")}.json`);
  }
}
