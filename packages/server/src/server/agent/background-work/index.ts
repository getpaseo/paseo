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

export interface HeartbeatBackgroundWorkInput {
  agentId: string;
  scheduleId: string;
  name: string | null;
  createdAt: string;
  stop: () => Promise<void>;
}

interface HeartbeatBackgroundWork {
  item: AgentBackgroundWorkItem;
  stop: HeartbeatBackgroundWorkInput["stop"];
}

const HEARTBEAT_ID_PREFIX = "heartbeat:";
const PROVIDER_ID_ESCAPE = "provider:";

export function isHeartbeatBackgroundWorkItem(item: { id: string }): boolean {
  return item.id.startsWith(HEARTBEAT_ID_PREFIX);
}

function encodeProviderItemId(id: string): string {
  // Preserve existing wire IDs outside the reserved namespaces.
  return id.startsWith(HEARTBEAT_ID_PREFIX) || id.startsWith(PROVIDER_ID_ESCAPE)
    ? PROVIDER_ID_ESCAPE + id
    : id;
}

/**
 * Live inventory per agent. Providers replace their entire contribution with `apply`.
 * The scheduler publishes heartbeats individually and retains ownership across provider closure.
 */
export class AgentBackgroundWorkStore {
  private readonly providerItems = new Map<string, AgentBackgroundWorkItem[]>();
  private readonly heartbeats = new Map<string, Map<string, HeartbeatBackgroundWork>>();

  apply(
    agentId: string,
    inputs: readonly AgentBackgroundWorkInput[],
    timestamp: string = new Date().toISOString(),
  ): AgentBackgroundWorkItem[] | null {
    const previous = this.providerItems.get(agentId);
    const previousById = new Map(previous?.map((item) => [item.id, item]));
    const seen = new Set<string>();
    const next: AgentBackgroundWorkItem[] = [];
    for (const input of inputs) {
      const id = encodeProviderItemId(input.id);
      if (seen.has(id)) continue;
      seen.add(id);
      next.push({
        id,
        kind: input.kind,
        description: input.description,
        ...(input.command ? { command: input.command } : {}),
        ...(input.canStop
          ? { canStop: true, stopToken: previousById.get(id)?.stopToken ?? randomUUID() }
          : {}),
        startedAt: previousById.get(id)?.startedAt ?? timestamp,
      });
    }
    if (previous && sameItems(previous, next)) return null;
    this.providerItems.set(agentId, next);
    return this.list(agentId);
  }

  setHeartbeat({
    agentId,
    scheduleId,
    name,
    createdAt,
    stop,
  }: HeartbeatBackgroundWorkInput): AgentBackgroundWorkItem[] | null {
    const id = HEARTBEAT_ID_PREFIX + scheduleId;
    const heartbeats = this.heartbeats.get(agentId) ?? new Map<string, HeartbeatBackgroundWork>();
    const previous = heartbeats.get(id)?.item;
    const item: AgentBackgroundWorkItem = {
      id,
      kind: "heartbeat",
      description: name,
      startedAt: createdAt,
      canStop: true,
      stopToken: previous?.stopToken ?? randomUUID(),
    };
    heartbeats.set(id, { item, stop });
    this.heartbeats.set(agentId, heartbeats);
    return previous?.description === name && previous.startedAt === createdAt
      ? null
      : this.list(agentId);
  }

  removeHeartbeat(agentId: string, scheduleId: string): AgentBackgroundWorkItem[] | null {
    const heartbeats = this.heartbeats.get(agentId);
    if (!heartbeats?.delete(HEARTBEAT_ID_PREFIX + scheduleId)) return null;
    if (heartbeats.size === 0) this.heartbeats.delete(agentId);
    return this.list(agentId);
  }

  async stopHeartbeat(agentId: string, itemId: string, stopToken: string): Promise<void> {
    const heartbeat = this.heartbeats.get(agentId)?.get(itemId);
    if (!heartbeat || heartbeat.item.stopToken !== stopToken) {
      throw new Error("Background work is no longer available to stop");
    }
    await heartbeat.stop();
  }

  authorizeProviderStop(agentId: string, itemId: string, stopToken: string): string {
    const item = this.providerItems.get(agentId)?.find(({ id }) => id === itemId);
    if (!item?.canStop || item.stopToken !== stopToken) {
      throw new Error("Background work is no longer available to stop");
    }
    return itemId.startsWith(PROVIDER_ID_ESCAPE) ? itemId.slice(PROVIDER_ID_ESCAPE.length) : itemId;
  }

  list(agentId: string): AgentBackgroundWorkItem[] {
    const items = [...(this.providerItems.get(agentId) ?? [])];
    for (const { item } of this.heartbeats.get(agentId)?.values() ?? []) {
      items.push(item);
    }
    return items;
  }

  summary(agentId: string): { count: number } | undefined {
    const items = this.providerItems.get(agentId);
    const heartbeats = this.heartbeats.get(agentId);
    return items || heartbeats
      ? { count: (items?.length ?? 0) + (heartbeats?.size ?? 0) }
      : undefined;
  }

  clear(agentId: string): AgentBackgroundWorkItem[] | null {
    if (!this.providerItems.delete(agentId)) return null;
    return this.list(agentId);
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
