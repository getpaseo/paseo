export interface AgentBackgroundWorkInput {
  id: string;
  /** Open string: "shell" or "other" today (Claude Monitor watches report as "shell"). */
  kind: string;
  description: string | null;
}

export interface AgentBackgroundWorkItem extends AgentBackgroundWorkInput {
  startedAt: string;
}

/**
 * Live background work per agent. Providers report the whole list on every change, so `apply`
 * replaces it. `startedAt` is stamped the first time an id is seen and kept while it stays listed.
 * Nothing is persisted: the work dies with the provider process.
 */
export class AgentBackgroundWorkStore {
  private readonly items = new Map<string, AgentBackgroundWorkItem[]>();

  apply(
    agentId: string,
    inputs: readonly AgentBackgroundWorkInput[],
    timestamp: string = new Date().toISOString(),
  ): AgentBackgroundWorkItem[] | null {
    const previous = this.items.get(agentId) ?? [];
    const startedAtById = new Map(previous.map((item) => [item.id, item.startedAt]));
    const seen = new Set<string>();
    const next: AgentBackgroundWorkItem[] = [];
    for (const input of inputs) {
      if (seen.has(input.id)) continue;
      seen.add(input.id);
      next.push({
        id: input.id,
        kind: input.kind,
        description: input.description,
        startedAt: startedAtById.get(input.id) ?? timestamp,
      });
    }
    if (sameItems(previous, next)) return null;
    if (next.length === 0) this.items.delete(agentId);
    else this.items.set(agentId, next);
    return [...next];
  }

  list(agentId: string): AgentBackgroundWorkItem[] {
    return [...(this.items.get(agentId) ?? [])];
  }

  clear(agentId: string): AgentBackgroundWorkItem[] | null {
    return this.apply(agentId, []);
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
        item.startedAt === other.startedAt
      );
    })
  );
}
