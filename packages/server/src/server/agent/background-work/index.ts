import { randomUUID } from "node:crypto";

export interface AgentBackgroundWorkInput {
  id: string;
  /** Provider-neutral kind; consumers treat unknown kinds as other work. */
  kind: string;
  description: string | null;
  command?: string;
  canStop?: boolean;
}

export interface AgentBackgroundWorkItem extends AgentBackgroundWorkInput {
  startedAt: string;
  stopToken?: string;
}

/**
 * Live background work per agent. Providers report the whole list on every change, so `apply`
 * replaces it. `startedAt` is stamped the first time an id is seen and kept while it stays listed.
 * Nothing is persisted; providers determine when their live inventory is no longer available.
 */
export class AgentBackgroundWorkStore {
  private readonly items = new Map<string, AgentBackgroundWorkItem[]>();

  apply(
    agentId: string,
    inputs: readonly AgentBackgroundWorkInput[],
    timestamp: string = new Date().toISOString(),
  ): AgentBackgroundWorkItem[] | null {
    const known = this.items.has(agentId);
    const previous = this.items.get(agentId) ?? [];
    const previousById = new Map(previous.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const next: AgentBackgroundWorkItem[] = [];
    for (const input of inputs) {
      if (seen.has(input.id)) continue;
      seen.add(input.id);
      next.push({
        id: input.id,
        kind: input.kind,
        description: input.description,
        ...(input.command ? { command: input.command } : {}),
        ...(input.canStop
          ? { canStop: true, stopToken: previousById.get(input.id)?.stopToken ?? randomUUID() }
          : {}),
        startedAt: previousById.get(input.id)?.startedAt ?? timestamp,
      });
    }
    if (known && sameItems(previous, next)) return null;
    this.items.set(agentId, next);
    return [...next];
  }

  list(agentId: string): AgentBackgroundWorkItem[] {
    return [...(this.items.get(agentId) ?? [])];
  }

  summary(agentId: string): { count: number } | undefined {
    const items = this.items.get(agentId);
    return items ? { count: items.length } : undefined;
  }

  clear(agentId: string): AgentBackgroundWorkItem[] | null {
    if (!this.items.delete(agentId)) return null;
    return [];
  }
}

function sameItems(
  left: readonly AgentBackgroundWorkItem[],
  right: readonly AgentBackgroundWorkItem[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        item.id === other.id &&
        item.kind === other.kind &&
        item.description === other.description &&
        item.command === other.command &&
        item.canStop === other.canStop &&
        item.stopToken === other.stopToken &&
        item.startedAt === other.startedAt
      );
    })
  );
}
