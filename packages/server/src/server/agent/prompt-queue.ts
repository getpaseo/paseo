import type { AgentPromptInput } from "./agent-sdk-types.js";

export interface HostPromptQueueItem {
  id: string;
  text: string;
  prompt: AgentPromptInput;
  messageId?: string;
}

export interface HostPromptQueuePreview {
  id: string;
  text: string;
}

/** In-memory follow-up prompts for one daemon process. Clients can disconnect. */
export class HostPromptQueue {
  private readonly items = new Map<string, HostPromptQueueItem[]>();

  list(agentId: string): HostPromptQueuePreview[] {
    return (this.items.get(agentId) ?? []).map(({ id, text }) => ({ id, text }));
  }

  enqueue(agentId: string, item: HostPromptQueueItem): void {
    const current = this.items.get(agentId) ?? [];
    this.items.set(agentId, [...current, item]);
  }

  remove(agentId: string, messageId: string): HostPromptQueueItem | null {
    const current = this.items.get(agentId) ?? [];
    const index = current.findIndex((item) => item.id === messageId);
    if (index < 0) return null;
    const removed = current[index] ?? null;
    this.items.set(agentId, [...current.slice(0, index), ...current.slice(index + 1)]);
    return removed;
  }

  shift(agentId: string): HostPromptQueueItem | null {
    const current = this.items.get(agentId) ?? [];
    const next = current[0];
    if (!next) return null;
    this.items.set(agentId, current.slice(1));
    return next;
  }

  unshift(agentId: string, item: HostPromptQueueItem): void {
    const current = this.items.get(agentId) ?? [];
    this.items.set(agentId, [item, ...current]);
  }
}
