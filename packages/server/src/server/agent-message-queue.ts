import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Logger } from "pino";
import {
  AgentAttachmentSchema,
  ImageAttachmentSchema,
  type AgentAttachment,
  type QueuedAgentMessagePayload,
  type QueuedAgentMessageQueuePayload,
} from "./messages.js";
import type { AgentPromptContentBlock, AgentPromptInput } from "./agent/agent-sdk-types.js";
import type { AgentManager } from "./agent/agent-manager.js";
import type { AgentStorage } from "./agent/agent-storage.js";
import { sendPromptToAgent } from "./agent/agent-prompt.js";
import { writeJsonFileAtomic } from "./atomic-file.js";

const DRAIN_RETRY_DELAYS_MS = [0, 25, 100, 250, 1000] as const;

const QueuedAgentMessageRecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  images: z.array(ImageAttachmentSchema).default([]),
  attachments: z.array(AgentAttachmentSchema).default([]),
  createdAt: z.string(),
});

const PersistedAgentMessageQueueSchema = z
  .object({
    version: z.literal(1).default(1),
    queues: z.record(z.string(), z.array(QueuedAgentMessageRecordSchema)).default({}),
    revisions: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .default({ version: 1, queues: {}, revisions: {} });

export type QueuedAgentMessageRecord = z.infer<typeof QueuedAgentMessageRecordSchema>;

export type AgentMessageQueuePayload = Omit<
  QueuedAgentMessagePayload,
  "images" | "attachments" | "imageCount" | "attachmentCount"
> & {
  images: Array<{ data: string; mimeType: string }>;
  attachments: AgentAttachment[];
  imageCount: number;
  attachmentCount: number;
};

export type AgentMessageQueueSnapshot = Omit<
  QueuedAgentMessageQueuePayload,
  "revision" | "messages"
> & {
  revision: number;
  messages: AgentMessageQueuePayload[];
};

type PersistedAgentMessageQueue = z.infer<typeof PersistedAgentMessageQueueSchema>;

export interface EnqueueAgentMessageInput {
  agentId: string;
  text: string;
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
  attachments?: AgentAttachment[];
}

export interface AgentMessageQueueStoreOptions {
  filePath: string;
  logger: Logger;
}

export class AgentMessageQueueStore {
  private cache: PersistedAgentMessageQueue | null = null;
  private loadPromise: Promise<PersistedAgentMessageQueue> | null = null;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: AgentMessageQueueStoreOptions) {}

  async hasMessages(agentId: string): Promise<boolean> {
    await this.mutationQueue;
    const state = await this.load();
    return (state.queues[agentId]?.length ?? 0) > 0;
  }

  async listQueues(agentId?: string): Promise<AgentMessageQueueSnapshot[]> {
    await this.mutationQueue;
    const state = await this.load();
    const agentIds = agentId
      ? [agentId]
      : Array.from(new Set([...Object.keys(state.queues), ...Object.keys(state.revisions)])).sort(
          (left, right) => left.localeCompare(right),
        );
    return agentIds
      .map((id) => toQueuedAgentMessageQueuePayload(state, id))
      .filter((queue) => agentId || queue.messages.length > 0 || queue.revision > 0);
  }

  async enqueue(
    input: EnqueueAgentMessageInput,
    options?: { ensureEligible?: () => Promise<void> },
  ): Promise<QueuedAgentMessageRecord> {
    const text = input.text.trim();
    if (!text && (input.images?.length ?? 0) === 0 && (input.attachments?.length ?? 0) === 0) {
      throw new Error("Queued message is empty");
    }

    return await this.mutate(async (state) => {
      // Runs inside the serialized mutation so an archive/delete cleanup that
      // was ordered ahead of this enqueue cannot be outrun by it.
      await options?.ensureEligible?.();
      if (input.messageId) {
        // This deduplicates only records that are still pending. Delivered ids
        // are not retained in a ledger and must not be treated as exactly-once.
        const existing = (state.queues[input.agentId] ?? []).find(
          (record) => record.id === input.messageId,
        );
        if (existing) {
          return cloneRecord(existing);
        }
      }
      const record: QueuedAgentMessageRecord = {
        id: input.messageId ?? randomUUID(),
        agentId: input.agentId,
        text,
        images: input.images ?? [],
        attachments: input.attachments ?? [],
        createdAt: new Date().toISOString(),
      };
      state.queues[input.agentId] = [...(state.queues[input.agentId] ?? []), record];
      bumpQueueRevision(state, input.agentId);
      return cloneRecord(record);
    });
  }

  async remove(agentId: string, queuedMessageId: string): Promise<QueuedAgentMessageRecord | null> {
    return await this.mutate(async (state) => {
      const queue = state.queues[agentId] ?? [];
      const index = queue.findIndex((record) => record.id === queuedMessageId);
      if (index === -1) {
        return null;
      }
      const [removed] = queue.splice(index, 1);
      setQueue(state, agentId, queue);
      bumpQueueRevision(state, agentId);
      return removed ? cloneRecord(removed) : null;
    });
  }

  async shift(agentId: string): Promise<QueuedAgentMessageRecord | null> {
    return await this.mutate(async (state) => {
      const queue = state.queues[agentId] ?? [];
      const removed = queue.shift() ?? null;
      setQueue(state, agentId, queue);
      if (removed) {
        bumpQueueRevision(state, agentId);
      }
      return removed ? cloneRecord(removed) : null;
    });
  }

  async unshift(record: QueuedAgentMessageRecord): Promise<void> {
    await this.mutate(async (state) => {
      state.queues[record.agentId] = [cloneRecord(record), ...(state.queues[record.agentId] ?? [])];
      bumpQueueRevision(state, record.agentId);
    });
  }

  async clearAgent(
    agentId: string,
    options?: { dropRevision?: boolean },
  ): Promise<AgentMessageQueueSnapshot | null> {
    return await this.mutate(async (state) => {
      const hadQueue = (state.queues[agentId]?.length ?? 0) > 0;
      const hadRevision = state.revisions[agentId] !== undefined;
      if (!hadQueue && (!options?.dropRevision || !hadRevision)) {
        return null;
      }
      const revision = getQueueRevision(state, agentId) + 1;
      delete state.queues[agentId];
      if (options?.dropRevision) {
        delete state.revisions[agentId];
      } else {
        state.revisions[agentId] = revision;
      }
      return { agentId, revision, messages: [] };
    });
  }

  private async mutate<T>(
    operation: (state: PersistedAgentMessageQueue) => Promise<T> | T,
  ): Promise<T> {
    const task = this.mutationQueue.then(async () => {
      // Mutate a draft and commit it to the cache only after the write
      // succeeds, so a failed persist cannot leave the in-memory state
      // claiming a change that was never durably stored.
      const draft = structuredClone(await this.load());
      const result = await operation(draft);
      await this.persist(draft);
      this.cache = draft;
      return result;
    });
    this.mutationQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return await task;
  }

  private async load(): Promise<PersistedAgentMessageQueue> {
    if (this.cache) {
      return this.cache;
    }
    if (this.loadPromise) {
      return await this.loadPromise;
    }
    const loadPromise = this.loadFromDisk();
    this.loadPromise = loadPromise;
    try {
      return await loadPromise;
    } finally {
      if (this.loadPromise === loadPromise) {
        this.loadPromise = null;
      }
    }
  }

  private async loadFromDisk(): Promise<PersistedAgentMessageQueue> {
    try {
      const raw = await readFile(this.options.filePath, "utf8");
      this.cache = PersistedAgentMessageQueueSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.cache = { version: 1, queues: {}, revisions: {} };
      } else if (error instanceof SyntaxError || error instanceof z.ZodError) {
        const corruptPath = `${this.options.filePath}.corrupt-${Date.now()}-${randomUUID()}`;
        await rename(this.options.filePath, corruptPath);
        this.options.logger.error(
          { err: error, corruptPath },
          "Quarantined corrupt agent message queue and started empty",
        );
        this.cache = { version: 1, queues: {}, revisions: {} };
      } else {
        this.options.logger.error({ err: error }, "Failed to load agent message queue");
        throw error;
      }
    }
    return this.cache;
  }

  private async persist(state: PersistedAgentMessageQueue): Promise<void> {
    pruneEmptyQueues(state);
    await writeJsonFileAtomic(this.options.filePath, state);
  }
}

export interface AgentMessageQueueServiceOptions {
  store: AgentMessageQueueStore;
  agentManager: AgentMessageQueueAgentManager;
  agentStorage: AgentMessageQueueAgentStorage;
  dispatchMessage: (
    record: QueuedAgentMessageRecord,
    options?: { replaceRunning?: boolean },
  ) => Promise<void>;
  logger: Logger;
  onQueueUpdated: (queue: AgentMessageQueueSnapshot) => void;
}

export interface AgentMessageQueueAgent {
  id: string;
  internal?: boolean;
  lifecycle: NonNullable<ReturnType<AgentManager["getAgent"]>>["lifecycle"];
}

export interface AgentMessageQueueAgentManager {
  getAgent(agentId: string): AgentMessageQueueAgent | null | undefined;
  hasInFlightRun(agentId: string): boolean;
  subscribeAgentState(listener: (agent: AgentMessageQueueAgent) => void): () => void;
  addAgentArchivedCallback: AgentManager["addAgentArchivedCallback"];
}

export interface AgentMessageQueueAgentStorage {
  get: AgentStorage["get"];
  list: AgentStorage["list"];
  addAgentHardDeletedCallback: AgentStorage["addAgentHardDeletedCallback"];
}

export interface AgentMessageQueueController {
  enqueue(input: EnqueueAgentMessageInput): Promise<AgentMessageQueuePayload>;
  list(agentId?: string): Promise<AgentMessageQueueSnapshot[]>;
  cancel(agentId: string, queuedMessageId: string): Promise<boolean>;
  dispatchNow(agentId: string, queuedMessageId: string): Promise<void>;
  clearAgent(agentId: string, options?: { dropRevision?: boolean }): Promise<void>;
}

export class AgentMessageQueueService implements AgentMessageQueueController {
  private unsubscribeAgentEvents: (() => void) | null = null;
  private unsubscribeAgentArchived: (() => void) | null = null;
  private unsubscribeAgentHardDeleted: (() => void) | null = null;
  private readonly scheduledDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly drainingAgents = new Set<string>();
  private readonly drainSendFailures = new Map<string, number>();

  constructor(private readonly options: AgentMessageQueueServiceOptions) {}

  async start(): Promise<void> {
    if (this.unsubscribeAgentEvents) {
      return;
    }
    this.unsubscribeAgentEvents = this.options.agentManager.subscribeAgentState((agent) => {
      if (agent.lifecycle !== "closed") {
        void this.scheduleDrainAgentQueueIfPresent(agent.id).catch((error) => {
          this.options.logger.error(
            { err: error, agentId: agent.id },
            "Failed to inspect queued agent messages",
          );
        });
      }
    });
    this.unsubscribeAgentArchived = this.options.agentManager.addAgentArchivedCallback(
      async (agentId) => {
        await this.clearAgent(agentId);
      },
    );
    this.unsubscribeAgentHardDeleted = this.options.agentStorage.addAgentHardDeletedCallback(
      async (agentId) => {
        await this.clearAgent(agentId, { dropRevision: true });
      },
    );
    await this.reconcilePersistedQueues().catch((error) => {
      this.options.logger.error(
        { err: error },
        "Failed to reconcile persisted agent message queues",
      );
    });
  }

  stop(): void {
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = null;
    this.unsubscribeAgentArchived?.();
    this.unsubscribeAgentArchived = null;
    this.unsubscribeAgentHardDeleted?.();
    this.unsubscribeAgentHardDeleted = null;
    for (const timeout of this.scheduledDrainTimers.values()) {
      clearTimeout(timeout);
    }
    this.scheduledDrainTimers.clear();
    this.drainSendFailures.clear();
  }

  async enqueue(input: EnqueueAgentMessageInput): Promise<AgentMessageQueuePayload> {
    const record = await this.options.store.enqueue(input, {
      ensureEligible: async () => {
        const reason = await this.getQueueUnavailableReason(input.agentId);
        if (reason) {
          throw new Error(reason);
        }
      },
    });
    this.drainSendFailures.delete(input.agentId);
    await this.emitQueueUpdated(input.agentId);
    this.scheduleDrainAgentQueue(input.agentId);
    return toQueuedAgentMessagePayload(record);
  }

  async getQueueUnavailableReason(agentId: string): Promise<string | null> {
    const live = this.options.agentManager.getAgent(agentId);
    if (live?.internal) {
      return `Cannot queue message for internal agent: ${agentId}`;
    }
    if (live?.lifecycle === "closed") {
      return `Cannot queue message for closed agent: ${agentId}`;
    }

    const stored = await this.options.agentStorage.get(agentId);
    if (!live && !stored) {
      return `Agent not found: ${agentId}`;
    }
    if (stored?.internal) {
      return `Cannot queue message for internal agent: ${agentId}`;
    }
    if (stored?.archivedAt) {
      return `Cannot queue message for archived agent: ${agentId}`;
    }

    return null;
  }

  async list(agentId?: string): Promise<AgentMessageQueueSnapshot[]> {
    return await this.options.store.listQueues(agentId);
  }

  async cancel(agentId: string, queuedMessageId: string): Promise<boolean> {
    const removed = await this.options.store.remove(agentId, queuedMessageId);
    if (removed) {
      await this.emitQueueUpdated(agentId);
    }
    return Boolean(removed);
  }

  async dispatchNow(agentId: string, queuedMessageId: string): Promise<void> {
    if (this.drainingAgents.has(agentId)) {
      throw new Error(`Agent queue is already dispatching: ${agentId}`);
    }
    this.drainingAgents.add(agentId);
    try {
      const record = await this.options.store.remove(agentId, queuedMessageId);
      if (!record) {
        throw new Error(`Queued message not found: ${queuedMessageId}`);
      }
      await this.emitQueueUpdated(agentId);
      try {
        await this.sendQueuedMessage(record, { replaceRunning: true });
        this.drainSendFailures.delete(agentId);
      } catch (error) {
        if (await this.canAgentEverReplay(agentId)) {
          await this.options.store.unshift(record);
          await this.emitQueueUpdated(agentId);
        }
        throw error;
      }
    } finally {
      this.drainingAgents.delete(agentId);
    }
  }

  async clearAgent(agentId: string, options?: { dropRevision?: boolean }): Promise<void> {
    const scheduled = this.scheduledDrainTimers.get(agentId);
    if (scheduled) {
      clearTimeout(scheduled);
      this.scheduledDrainTimers.delete(agentId);
    }
    this.drainSendFailures.delete(agentId);
    const clearedQueue = await this.options.store.clearAgent(agentId, options);
    if (clearedQueue) {
      this.options.onQueueUpdated(clearedQueue);
    }
  }

  private scheduleDrainAgentQueue(agentId: string, attempt = 0): void {
    if (this.scheduledDrainTimers.has(agentId)) {
      return;
    }

    const delayMs = DRAIN_RETRY_DELAYS_MS[Math.min(attempt, DRAIN_RETRY_DELAYS_MS.length - 1)] ?? 0;
    const timeout = setTimeout(() => {
      this.scheduledDrainTimers.delete(agentId);
      void this.runScheduledDrain(agentId, attempt).catch((error) => {
        this.options.logger.error({ err: error, agentId }, "Failed to drain queued agent messages");
      });
    }, delayMs);
    this.scheduledDrainTimers.set(agentId, timeout);
  }

  private async scheduleDrainAgentQueueIfPresent(agentId: string): Promise<void> {
    if (await this.options.store.hasMessages(agentId)) {
      this.scheduleDrainAgentQueue(agentId);
    }
  }

  private async runScheduledDrain(agentId: string, attempt: number): Promise<void> {
    if (await this.isAgentAvailableForAutoReplay(agentId)) {
      if (await this.hasQueuedMessages(agentId)) {
        await this.drainAgentQueue(agentId);
      }
      return;
    }
    if (attempt + 1 < DRAIN_RETRY_DELAYS_MS.length && (await this.canAgentEverReplay(agentId))) {
      this.scheduleDrainAgentQueue(agentId, attempt + 1);
    }
  }

  private async reconcilePersistedQueues(): Promise<void> {
    const queues = await this.options.store.listQueues();
    const storedAgentIds = new Set(
      (await this.options.agentStorage.list()).map((record) => record.id),
    );
    for (const queue of queues) {
      const hasStoredAgent = storedAgentIds.has(queue.agentId);
      const hasLiveAgent = Boolean(this.options.agentManager.getAgent(queue.agentId));
      const hasAgent = hasStoredAgent || hasLiveAgent;
      if (!hasAgent) {
        await this.clearAgent(queue.agentId, { dropRevision: true });
        continue;
      }
      if (queue.messages.length > 0) {
        this.scheduleDrainAgentQueue(queue.agentId);
      }
    }
  }

  private async hasQueuedMessages(agentId: string): Promise<boolean> {
    return await this.options.store.hasMessages(agentId);
  }

  private async drainAgentQueue(agentId: string): Promise<void> {
    if (this.drainingAgents.has(agentId)) {
      return;
    }
    this.drainingAgents.add(agentId);
    let retryAfterFailure = false;
    try {
      while (await this.isAgentAvailableForAutoReplay(agentId)) {
        const record = await this.options.store.shift(agentId);
        if (!record) {
          return;
        }
        await this.emitQueueUpdated(agentId);
        try {
          await this.sendQueuedMessage(record, { replaceRunning: false });
          this.drainSendFailures.delete(agentId);
        } catch (error) {
          if (await this.canAgentEverReplay(agentId)) {
            await this.options.store.unshift(record);
            await this.emitQueueUpdated(agentId);
            retryAfterFailure = true;
          }
          this.options.logger.warn(
            { err: error, agentId, queuedMessageId: record.id },
            "Failed to dispatch queued agent message",
          );
          return;
        }
      }
    } finally {
      this.drainingAgents.delete(agentId);
      if (retryAfterFailure) {
        // Escalate the delay across consecutive send failures; after the
        // ladder is exhausted, wait for the next agent event (or a new
        // enqueue) instead of retrying in a tight loop.
        const attempt = (this.drainSendFailures.get(agentId) ?? 0) + 1;
        this.drainSendFailures.set(agentId, attempt);
        if (attempt < DRAIN_RETRY_DELAYS_MS.length) {
          this.scheduleDrainAgentQueue(agentId, attempt);
        } else {
          this.options.logger.warn(
            { agentId },
            "Suspending queued message replay until the next agent event",
          );
        }
      }
    }
  }

  private async isAgentAvailableForAutoReplay(agentId: string): Promise<boolean> {
    if (!(await this.canAgentEverReplay(agentId))) {
      return false;
    }
    return !this.options.agentManager.hasInFlightRun(agentId);
  }

  private async canAgentEverReplay(agentId: string): Promise<boolean> {
    return (await this.getQueueUnavailableReason(agentId)) === null;
  }

  private async sendQueuedMessage(
    record: QueuedAgentMessageRecord,
    options?: { replaceRunning?: boolean },
  ): Promise<void> {
    await this.options.dispatchMessage(record, options);
  }

  private async emitQueueUpdated(agentId: string): Promise<void> {
    const [queue] = await this.options.store.listQueues(agentId);
    const payload = queue ?? { agentId, revision: 0, messages: [] };
    // Updates fan out to every capable client on every queue change, so omit
    // large image and attachment payloads from the broadcast. Counts stay
    // accurate; clients hydrate unseen messages via queue.agent_message.list.
    // listQueues returns cloned records, so mutating them here is safe.
    for (const message of payload.messages) {
      message.images = [];
      message.attachments = [];
    }
    this.options.onQueueUpdated(payload);
  }
}

export function createAgentMessageQueueService(input: {
  paseoHome: string;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  logger: Logger;
  onQueueUpdated: (queue: AgentMessageQueueSnapshot) => void;
}): AgentMessageQueueService {
  return new AgentMessageQueueService({
    store: new AgentMessageQueueStore({
      filePath: join(input.paseoHome, "agent-message-queue.json"),
      logger: input.logger,
    }),
    agentManager: {
      getAgent: (agentId) => input.agentManager.getAgent(agentId),
      hasInFlightRun: (agentId) => input.agentManager.hasInFlightRun(agentId),
      subscribeAgentState: (listener) =>
        input.agentManager.subscribe(
          (event) => {
            if (event.type === "agent_state") listener(event.agent);
          },
          { replayState: false },
        ),
      addAgentArchivedCallback: (callback) => input.agentManager.addAgentArchivedCallback(callback),
    },
    agentStorage: {
      get: (agentId) => input.agentStorage.get(agentId),
      list: () => input.agentStorage.list(),
      addAgentHardDeletedCallback: (callback) =>
        input.agentStorage.addAgentHardDeletedCallback(callback),
    },
    dispatchMessage: async (record, options) => {
      const prompt = buildQueuedAgentPrompt(record.text, record.images, record.attachments);
      const result = await sendPromptToAgent({
        agentManager: input.agentManager,
        agentStorage: input.agentStorage,
        agentId: record.agentId,
        prompt,
        messageId: record.id,
        replaceRunning: options?.replaceRunning,
        unarchive: false,
        logger: input.logger,
      });
      if (result.skippedReason === "archived") {
        throw new Error(`Queued message target agent is archived: ${record.agentId}`);
      }
      if (result.disposition === "turn_started") {
        await result.startAcknowledged;
      }
    },
    logger: input.logger,
    onQueueUpdated: input.onQueueUpdated,
  });
}

export function toQueuedAgentMessagePayload(
  record: QueuedAgentMessageRecord,
): AgentMessageQueuePayload {
  return {
    id: record.id,
    agentId: record.agentId,
    text: record.text,
    createdAt: record.createdAt,
    images: record.images.map((image) => ({ ...image })),
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
    imageCount: record.images.length,
    attachmentCount: record.attachments.length,
  };
}

function toQueuedAgentMessageQueuePayload(
  state: PersistedAgentMessageQueue,
  agentId: string,
): AgentMessageQueueSnapshot {
  return {
    agentId,
    revision: getQueueRevision(state, agentId),
    messages: (state.queues[agentId] ?? []).map(toQueuedAgentMessagePayload),
  };
}

export function buildQueuedAgentPrompt(
  text: string,
  images: Array<{ data: string; mimeType: string }>,
  attachments: AgentAttachment[],
): AgentPromptInput {
  const normalized = text.trim();
  if (images.length === 0 && attachments.length === 0) {
    return normalized;
  }
  const blocks: AgentPromptContentBlock[] = [];
  if (normalized.length > 0) {
    blocks.push({ type: "text", text: normalized });
  }
  for (const image of images) {
    blocks.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  for (const attachment of attachments) {
    blocks.push(attachment);
  }
  return blocks;
}

function setQueue(
  state: PersistedAgentMessageQueue,
  agentId: string,
  queue: QueuedAgentMessageRecord[],
): void {
  if (queue.length === 0) {
    delete state.queues[agentId];
    return;
  }
  state.queues[agentId] = queue;
}

function pruneEmptyQueues(state: PersistedAgentMessageQueue): void {
  for (const [agentId, queue] of Object.entries(state.queues)) {
    if (queue.length === 0) {
      delete state.queues[agentId];
    }
  }
}

function getQueueRevision(state: PersistedAgentMessageQueue, agentId: string): number {
  return state.revisions[agentId] ?? 0;
}

function bumpQueueRevision(state: PersistedAgentMessageQueue, agentId: string): void {
  state.revisions[agentId] = getQueueRevision(state, agentId) + 1;
}

function cloneRecord(record: QueuedAgentMessageRecord): QueuedAgentMessageRecord {
  return {
    ...record,
    images: record.images.map((image) => ({ ...image })),
    attachments: record.attachments.map((attachment) => ({ ...attachment })),
  };
}
