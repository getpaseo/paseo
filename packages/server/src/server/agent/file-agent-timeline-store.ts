import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";

const TimelineRowSchema: z.ZodType<AgentTimelineRow> = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
  providerTimelineItemId: z.string().optional(),
  revertToken: z.json().optional(),
});

const TimelineFileSchema = z.object({
  epoch: z.string(),
  rows: z.array(TimelineRowSchema),
});

type TimelineFile = z.infer<typeof TimelineFileSchema>;

/** File-backed ownership for canonical provider timeline rows. */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly mutations = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string) {}

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return this.mutate(agentId, async (timeline) => {
      const row: AgentTimelineRow = {
        seq: (timeline.rows.at(-1)?.seq ?? 0) + 1,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item,
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      };
      timeline.rows.push(row);
      return row;
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const timeline = await this.readAfterPendingMutation(agentId);
    return memoryStore(agentId, timeline).fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    const timeline = await this.readAfterPendingMutation(agentId);
    return timeline.rows.at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return (await this.readAfterPendingMutation(agentId)).rows;
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const timeline = await this.readAfterPendingMutation(agentId);
    return timeline.rows.at(-1)?.item ?? null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const timeline = await this.readAfterPendingMutation(agentId);
    return memoryStore(agentId, timeline).getLastAssistantMessage(agentId);
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.serialize(agentId, () => rm(this.filePath(agentId), { force: true }));
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.mutate(agentId, async (timeline) => {
      const bySeq = new Map(timeline.rows.map((row) => [row.seq, row]));
      for (const row of rows) bySeq.set(row.seq, row);
      timeline.rows = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.mutate(agentId, async (timeline) => {
      const index = timeline.rows.findIndex((candidate) => candidate.seq === row.seq);
      if (index >= 0) timeline.rows[index] = row;
    });
  }

  private filePath(agentId: string): string {
    return join(this.directory, `${encodeURIComponent(agentId)}.json`);
  }

  private async readAfterPendingMutation(agentId: string): Promise<TimelineFile> {
    return this.serialize(agentId, () => this.read(agentId));
  }

  private async read(agentId: string): Promise<TimelineFile> {
    try {
      return TimelineFileSchema.parse(JSON.parse(await readFile(this.filePath(agentId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { epoch: randomUUID(), rows: [] };
      }
      throw error;
    }
  }

  private async mutate<T>(
    agentId: string,
    mutation: (timeline: TimelineFile) => T | Promise<T>,
  ): Promise<T> {
    return this.serialize(agentId, async () => {
      const timeline = await this.read(agentId);
      const result = await mutation(timeline);
      await writeJsonFileAtomic(this.filePath(agentId), TimelineFileSchema.parse(timeline));
      return result;
    });
  }

  private async serialize<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(agentId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutations.set(agentId, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(agentId) === next) this.mutations.delete(agentId);
    }
  }
}

function memoryStore(agentId: string, timeline: TimelineFile): InMemoryAgentTimelineStore {
  const store = new InMemoryAgentTimelineStore();
  store.initialize(agentId, {
    epoch: timeline.epoch,
    rows: timeline.rows,
    nextSeq: (timeline.rows.at(-1)?.seq ?? 0) + 1,
  });
  return store;
}
