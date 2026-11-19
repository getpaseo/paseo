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

export interface DaemonBackgroundWorkKey {
  agentId: string;
  namespace: "heartbeat" | "change-request-watch";
  id: string;
}

export interface DaemonBackgroundWorkInput extends DaemonBackgroundWorkKey {
  kind: string;
  description: string | null;
  startedAt: string;
  stop: () => Promise<void>;
}

interface DaemonBackgroundWork {
  item: AgentBackgroundWorkItem;
  stop: DaemonBackgroundWorkInput["stop"];
}

const HEARTBEAT_ID_PREFIX = "heartbeat:";
const DAEMON_ID_PREFIX = "daemon:";
const PROVIDER_ID_ESCAPE = "provider:";

export function isDaemonBackgroundWorkItem(item: { id: string }): boolean {
  return item.id.startsWith(HEARTBEAT_ID_PREFIX) || item.id.startsWith(DAEMON_ID_PREFIX);
}

function daemonItemId({ namespace, id }: DaemonBackgroundWorkKey): string {
  return namespace === "heartbeat"
    ? HEARTBEAT_ID_PREFIX + id
    : `${DAEMON_ID_PREFIX}${namespace}:${id}`;
}

function encodeProviderItemId(id: string): string {
  // Preserve existing wire IDs outside the reserved namespaces.
  return isDaemonBackgroundWorkItem({ id }) || id.startsWith(PROVIDER_ID_ESCAPE)
    ? PROVIDER_ID_ESCAPE + id
    : id;
}

/**
 * Live inventory per agent. Providers replace their entire contribution with `apply`.
 * Daemon services publish individual items that outlive provider sessions.
 */
export class AgentBackgroundWorkStore {
  private readonly providerItems = new Map<string, AgentBackgroundWorkItem[]>();
  private readonly daemonItems = new Map<string, Map<string, DaemonBackgroundWork>>();

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

  setDaemonBackgroundWork(input: DaemonBackgroundWorkInput): AgentBackgroundWorkItem[] | null {
    const { agentId, kind, description, startedAt, stop } = input;
    const id = daemonItemId(input);
    const items = this.daemonItems.get(agentId) ?? new Map<string, DaemonBackgroundWork>();
    const previous = items.get(id)?.item;
    const item: AgentBackgroundWorkItem = {
      id,
      kind,
      description,
      startedAt,
      canStop: true,
      stopToken: previous?.stopToken ?? randomUUID(),
    };
    items.set(id, { item, stop });
    this.daemonItems.set(agentId, items);
    return previous && sameItems([previous], [item]) ? null : this.list(agentId);
  }

  removeDaemonBackgroundWork(key: DaemonBackgroundWorkKey): AgentBackgroundWorkItem[] | null {
    const { agentId } = key;
    const items = this.daemonItems.get(agentId);
    if (!items?.delete(daemonItemId(key))) return null;
    if (items.size === 0) this.daemonItems.delete(agentId);
    return this.list(agentId);
  }

  async stopDaemon(agentId: string, itemId: string, stopToken: string): Promise<void> {
    const work = this.daemonItems.get(agentId)?.get(itemId);
    if (!work || work.item.stopToken !== stopToken) {
      throw new Error("Background work is no longer available to stop");
    }
    await work.stop();
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
    for (const { item } of this.daemonItems.get(agentId)?.values() ?? []) {
      items.push(item);
    }
    return items;
  }

  summary(agentId: string): { count: number } | undefined {
    const items = this.providerItems.get(agentId);
    const daemonItems = this.daemonItems.get(agentId);
    return items || daemonItems
      ? { count: (items?.length ?? 0) + (daemonItems?.size ?? 0) }
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
