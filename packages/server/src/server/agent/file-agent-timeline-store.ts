import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { writeJsonFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import { AgentTimelineItemPayloadSchema } from "@getpaseo/protocol/messages";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineSnapshot,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

const TimelineRowSchema: z.ZodType<AgentTimelineRow, unknown> = z.object({
  seq: z.number().int().positive(),
  timestamp: z.string(),
  item: AgentTimelineItemPayloadSchema,
  turnId: z.string().optional(),
  providerMessageId: z.string().optional(),
});

const TimelineDocumentSchema = z.object({
  version: z.literal(1),
  epoch: z.string(),
  nextSeq: z.number().int().positive(),
  rows: z.array(TimelineRowSchema),
  // Documents written before history completeness existed are intentionally incomplete.
  historyComplete: z.boolean().optional().default(false),
});

type TimelineDocument = z.infer<typeof TimelineDocumentSchema>;

export interface FileAgentTimelineStoreOptions {
  writeJson?: (filePath: string, value: unknown) => Promise<void>;
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function cloneDocument(document: TimelineDocument): TimelineDocument {
  return { ...document, rows: document.rows.map(cloneRow) };
}

function validateDocument(value: unknown): TimelineDocument {
  const document = TimelineDocumentSchema.parse(value);
  let previousSeq = 0;
  for (const row of document.rows) {
    if (row.seq <= previousSeq) {
      throw new Error("Timeline rows must have strictly increasing sequence numbers");
    }
    previousSeq = row.seq;
  }
  if (document.nextSeq <= previousSeq) {
    throw new Error("Timeline nextSeq must be greater than every row sequence number");
  }
  return document;
}

function emptyDocument(): TimelineDocument {
  return { version: 1, epoch: randomUUID(), nextSeq: 1, rows: [], historyComplete: false };
}

function fileNameForAgent(agentId: string): string {
  return `agent-${Buffer.from(agentId, "utf8").toString("base64url")}.json`;
}

function selectRows(
  document: TimelineDocument,
  options?: AgentTimelineFetchOptions,
): AgentTimelineFetchResult {
  const memory = new InMemoryAgentTimelineStore();
  memory.initialize("timeline", document);
  return memory.fetch("timeline", options);
}

/** Durable canonical timeline rows, isolated as one atomic document per agent. */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly documents = new Map<string, TimelineDocument>();
  private readonly loading = new Map<string, Promise<TimelineDocument>>();
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly writeJson: (filePath: string, value: unknown) => Promise<void>;

  constructor(
    private readonly directory: string,
    options?: FileAgentTimelineStoreOptions,
  ) {
    this.writeJson = options?.writeJson ?? writeJsonFileAtomic;
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    return this.mutate(agentId, (document) => {
      const row: AgentTimelineRow = {
        seq: document.nextSeq,
        timestamp: options?.timestamp ?? new Date().toISOString(),
        item: structuredClone(item),
        ...(options?.turnId ? { turnId: options.turnId } : {}),
      };
      document.rows.push(row);
      document.nextSeq += 1;
      return cloneRow(row);
    });
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return selectRows(await this.getDocument(agentId), options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return (await this.getDocument(agentId)).rows.at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return (await this.getDocument(agentId)).rows.map(cloneRow);
  }

  async getCommittedSnapshot(agentId: string): Promise<AgentTimelineSnapshot> {
    const document = await this.getDocument(agentId);
    return { rows: document.rows.map(cloneRow), historyComplete: document.historyComplete };
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const item = (await this.getDocument(agentId)).rows.at(-1)?.item;
    return item ? structuredClone(item) : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    const rows = (await this.getDocument(agentId)).rows;
    const chunks: string[] = [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const item = rows[index]!.item;
      if (item.type !== "assistant_message") {
        if (chunks.length > 0) break;
        continue;
      }
      chunks.push(item.text);
    }
    return chunks.length > 0 ? chunks.toReversed().join("") : null;
  }

  async deleteAgent(agentId: string): Promise<void> {
    await this.runMutation(agentId, async () => {
      await fs.rm(this.filePath(agentId), { force: true });
      this.documents.delete(agentId);
    });
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    await this.runMutation(agentId, async () => {
      const current = await this.getDocument(agentId);
      const proposed = cloneDocument(current);
      let changed = false;
      for (const row of rows) {
        const parsed = TimelineRowSchema.parse(row);
        const existing = proposed.rows.find((candidate) => candidate.seq === parsed.seq);
        if (existing) {
          if (!isDeepStrictEqual(existing, parsed)) {
            throw new Error(`Conflicting timeline row sequence ${parsed.seq}`);
          }
          continue;
        }
        proposed.rows.push(cloneRow(parsed));
        changed = true;
      }
      if (!changed) return;
      proposed.rows.sort((left, right) => left.seq - right.seq);
      const maxSeq = proposed.rows.at(-1)?.seq ?? 0;
      proposed.nextSeq = Math.max(proposed.nextSeq, maxSeq + 1);
      validateDocument(proposed);
      await this.writeJson(this.filePath(agentId), proposed);
      this.documents.set(agentId, proposed);
    });
  }

  async replaceCommittedSnapshot(agentId: string, snapshot: AgentTimelineSnapshot): Promise<void> {
    await this.runMutation(agentId, async () => {
      const current = await this.getDocument(agentId);
      const rows = snapshot.rows.map((row) => cloneRow(TimelineRowSchema.parse(row)));
      const nextSeq = (rows.at(-1)?.seq ?? 0) + 1;
      const proposed: TimelineDocument = {
        version: 1,
        epoch: current.epoch,
        nextSeq,
        rows,
        historyComplete: snapshot.historyComplete,
      };
      validateDocument(proposed);
      await this.writeJson(this.filePath(agentId), proposed);
      this.documents.set(agentId, proposed);
    });
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    await this.mutate(agentId, (document) => {
      const parsed = TimelineRowSchema.parse(row);
      const index = document.rows.findIndex((candidate) => candidate.seq === parsed.seq);
      if (index < 0) {
        throw new Error(`Cannot update missing timeline row sequence ${parsed.seq}`);
      }
      document.rows[index] = cloneRow(parsed);
    });
  }

  private async mutate<T>(
    agentId: string,
    mutation: (document: TimelineDocument) => T,
  ): Promise<T> {
    return this.runMutation(agentId, async () => {
      const current = await this.getDocument(agentId);
      const proposed = cloneDocument(current);
      const result = mutation(proposed);
      validateDocument(proposed);
      await this.writeJson(this.filePath(agentId), proposed);
      this.documents.set(agentId, proposed);
      return result;
    });
  }

  private async getDocument(agentId: string): Promise<TimelineDocument> {
    const cached = this.documents.get(agentId);
    if (cached) return cached;
    let load = this.loading.get(agentId);
    if (!load) {
      load = this.loadDocument(agentId);
      this.loading.set(agentId, load);
    }
    try {
      const document = await load;
      this.documents.set(agentId, document);
      return document;
    } finally {
      if (this.loading.get(agentId) === load) this.loading.delete(agentId);
    }
  }

  private async loadDocument(agentId: string): Promise<TimelineDocument> {
    try {
      return validateDocument(JSON.parse(await fs.readFile(this.filePath(agentId), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyDocument();
      throw error;
    }
  }

  private async runMutation<T>(agentId: string, operation: () => Promise<T>): Promise<T> {
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
    return result;
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, fileNameForAgent(agentId));
  }
}
