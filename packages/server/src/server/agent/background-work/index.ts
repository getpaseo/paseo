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

export interface AgentBackgroundWorkSummary {
  count: number;
  nextWakeAt?: string;
}

/**
 * Live background work per agent. Providers report the whole list on every change, so `apply`
 * replaces it. `startedAt` is stamped the first time an id is seen and kept while it stays listed.
 * Nothing is persisted; providers determine when their live inventory is no longer available.
 */
export class AgentBackgroundWorkStore {
  private readonly items = new Map<string, AgentBackgroundWorkItem[]>();
  private readonly nextWakeAt = new Map<string, string>();

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

  /** A pending wake is kept apart from the items: the agent stays idle until it fires. */
  setNextWakeAt(agentId: string, nextWakeAt: string | null): boolean {
    if ((this.nextWakeAt.get(agentId) ?? null) === nextWakeAt) return false;
    if (nextWakeAt === null) this.nextWakeAt.delete(agentId);
    else this.nextWakeAt.set(agentId, nextWakeAt);
    return true;
  }

  summary(agentId: string): AgentBackgroundWorkSummary | undefined {
    const items = this.items.get(agentId);
    const nextWakeAt = this.nextWakeAt.get(agentId);
    if (!items && !nextWakeAt) return undefined;
    return { count: items?.length ?? 0, ...(nextWakeAt ? { nextWakeAt } : {}) };
  }

  clear(agentId: string): AgentBackgroundWorkItem[] | null {
    const hadWake = this.nextWakeAt.delete(agentId);
    if (!this.items.delete(agentId) && !hadWake) return null;
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
