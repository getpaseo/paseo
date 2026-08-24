import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { writeJsonFileAtomic } from "../atomic-file.js";
import { AgentAttachmentSchema, type AgentAttachment } from "../messages.js";

const QUEUED_PROMPT_SCHEMA = z.object({
  id: z.string(),
  agentId: z.string(),
  text: z.string(),
  attachments: z.array(AgentAttachmentSchema),
  createdAt: z.string(),
  createdByClientId: z.string(),
});

const QUEUE_FILE_SCHEMA = z.object({ prompts: z.array(QUEUED_PROMPT_SCHEMA).default([]) });

export type AgentQueuedPrompt = z.infer<typeof QUEUED_PROMPT_SCHEMA>;

function clone(prompt: AgentQueuedPrompt): AgentQueuedPrompt {
  return { ...prompt, attachments: [...prompt.attachments] };
}

export class AgentQueueStore {
  private readonly promptsByAgent = new Map<string, AgentQueuedPrompt[]>();
  private readonly loadPromises = new Map<string, Promise<void>>();
  private readonly writesByAgent = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(agentId: string, prompts: AgentQueuedPrompt[]) => void>();

  constructor(
    private readonly agentRoot: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async list(agentId: string): Promise<AgentQueuedPrompt[]> {
    await this.load(agentId);
    return (this.promptsByAgent.get(agentId) ?? []).map(clone);
  }

  async enqueue(input: {
    agentId: string;
    text: string;
    attachments?: AgentAttachment[];
    createdByClientId: string;
  }): Promise<AgentQueuedPrompt> {
    const text = input.text.trim();
    if (!text && !input.attachments?.length) {
      throw new Error("Queued prompt needs text or an attachment");
    }
    return this.mutate(input.agentId, (current) => {
      const prompt: AgentQueuedPrompt = {
        id: randomUUID(),
        agentId: input.agentId,
        text,
        attachments: [...(input.attachments ?? [])],
        createdAt: this.now().toISOString(),
        createdByClientId: input.createdByClientId,
      };
      return { next: [...current, prompt], value: prompt };
    });
  }

  async update(input: {
    agentId: string;
    promptId: string;
    text: string;
    attachments?: AgentAttachment[];
  }): Promise<AgentQueuedPrompt | null> {
    const text = input.text.trim();
    return this.mutate(input.agentId, (current) => {
      const index = current.findIndex((prompt) => prompt.id === input.promptId);
      if (index < 0) return { next: current, value: null };
      const attachments = input.attachments ?? current[index]!.attachments;
      if (!text && attachments.length === 0) {
        throw new Error("Queued prompt needs text or an attachment");
      }
      const updated: AgentQueuedPrompt = {
        ...current[index]!,
        text,
        attachments: [...attachments],
      };
      const next = [...current];
      next[index] = updated;
      return { next, value: updated };
    });
  }

  async reorder(agentId: string, promptIds: string[]): Promise<AgentQueuedPrompt[]> {
    return this.mutate(agentId, (current) => {
      if (promptIds.length !== current.length || new Set(promptIds).size !== current.length) {
        throw new Error("Queue reorder must contain every prompt exactly once");
      }
      const byId = new Map(current.map((prompt) => [prompt.id, prompt]));
      const next = promptIds.map((id) => byId.get(id));
      if (next.some((prompt) => !prompt))
        throw new Error("Queue reorder contains an unknown prompt");
      return { next: next as AgentQueuedPrompt[], value: next as AgentQueuedPrompt[] };
    });
  }

  async delete(agentId: string, promptId: string): Promise<AgentQueuedPrompt | null> {
    return this.mutate(agentId, (current) => {
      const removed = current.find((prompt) => prompt.id === promptId) ?? null;
      return { next: current.filter((prompt) => prompt.id !== promptId), value: removed };
    });
  }

  async take(agentId: string, promptId?: string): Promise<AgentQueuedPrompt | null> {
    return this.mutate(agentId, (current) => {
      const index = promptId ? current.findIndex((prompt) => prompt.id === promptId) : 0;
      if (index < 0 || !current[index]) return { next: current, value: null };
      const prompt = current[index];
      return { next: current.filter((_, candidate) => candidate !== index), value: prompt };
    });
  }

  async restoreFront(prompt: AgentQueuedPrompt): Promise<void> {
    await this.mutate(prompt.agentId, (current) => ({
      next: [prompt, ...current.filter((candidate) => candidate.id !== prompt.id)],
      value: undefined,
    }));
  }

  async clear(agentId: string): Promise<void> {
    await this.mutate(agentId, () => ({ next: [], value: undefined }));
  }

  subscribe(listener: (agentId: string, prompts: AgentQueuedPrompt[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private async mutate<T>(
    agentId: string,
    mutation: (current: AgentQueuedPrompt[]) => { next: AgentQueuedPrompt[]; value: T },
  ): Promise<T> {
    const previous = this.writesByAgent.get(agentId) ?? Promise.resolve();
    let resolveValue!: (value: T) => void;
    let rejectValue!: (error: unknown) => void;
    const value = new Promise<T>((resolve, reject) => {
      resolveValue = resolve;
      rejectValue = reject;
    });
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        await this.load(agentId);
        const result = mutation(this.promptsByAgent.get(agentId) ?? []);
        this.promptsByAgent.set(agentId, result.next);
        await writeJsonFileAtomic(this.filePath(agentId), { prompts: result.next });
        for (const listener of this.listeners) {
          try {
            listener(agentId, result.next.map(clone));
          } catch {
            // Queue persistence remains authoritative if a presentation subscriber fails.
          }
        }
        resolveValue(result.value);
        return undefined;
      })
      .catch((error) => {
        rejectValue(error);
        return undefined;
      });
    const tracked = write.finally(() => {
      if (this.writesByAgent.get(agentId) === tracked) this.writesByAgent.delete(agentId);
    });
    this.writesByAgent.set(agentId, tracked);
    return value;
  }

  private async load(agentId: string): Promise<void> {
    if (this.promptsByAgent.has(agentId)) return;
    const existing = this.loadPromises.get(agentId);
    if (existing) return existing;
    const loading = (async () => {
      try {
        const raw = await fs.readFile(this.filePath(agentId), "utf8");
        const parsed = QUEUE_FILE_SCHEMA.safeParse(JSON.parse(raw));
        this.promptsByAgent.set(agentId, parsed.success ? parsed.data.prompts : []);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          this.promptsByAgent.set(agentId, []);
          return;
        }
        throw error;
      }
    })();
    this.loadPromises.set(agentId, loading);
    try {
      await loading;
    } finally {
      this.loadPromises.delete(agentId);
    }
  }

  private filePath(agentId: string): string {
    return path.join(this.agentRoot, "queues", `${agentId}.json`);
  }
}
