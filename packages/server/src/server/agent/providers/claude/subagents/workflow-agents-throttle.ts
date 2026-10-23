import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";

/**
 * Paces workflow agent lists on their way to clients.
 *
 * Every progress frame carries the whole list, and a swarm of hundreds of agents produces one per
 * state change. Clients only need the latest list, so an upsert that carries nothing else goes
 * out at most once per interval per subagent, and the newest one held back goes out when the
 * interval ends. A status change or removal sends the held list first, so a terminal status never
 * overtakes the agents it settled; other events, such as a usage subtitle, pass it by.
 */
export class WorkflowAgentsThrottle {
  private readonly lastSentAt = new Map<string, number>();
  private readonly held = new Map<string, ProviderSubagentInputEvent>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly options: {
      intervalMs: number;
      /** Receives held lists when their interval ends. */
      send: (event: ProviderSubagentInputEvent) => void;
      now?: () => number;
    },
  ) {}

  /** The events to send now, in order. Held lists leave later through `send`. */
  route(events: readonly ProviderSubagentInputEvent[]): ProviderSubagentInputEvent[] {
    const ready: ProviderSubagentInputEvent[] = [];
    for (const event of events) {
      if (!isWorkflowAgentsOnly(event)) {
        if (event.type === "upsert" && event.workflowAgents !== undefined) {
          // A newer list rides along, so the held one is stale.
          this.take(event.id);
        } else if (event.type === "remove" || (event.type === "upsert" && event.status)) {
          const held = this.take(event.id);
          if (held) ready.push(held);
        }
        ready.push(event);
        continue;
      }
      const now = this.now();
      const lastSentAt = this.lastSentAt.get(event.id);
      if (
        !this.held.has(event.id) &&
        (lastSentAt === undefined || now - lastSentAt >= this.interval)
      ) {
        this.lastSentAt.set(event.id, now);
        ready.push(event);
        continue;
      }
      this.held.set(event.id, event);
      if (!this.timers.has(event.id)) {
        const wait = Math.max(0, (lastSentAt ?? now) + this.interval - now);
        this.timers.set(
          event.id,
          setTimeout(() => {
            const held = this.take(event.id);
            if (held) this.options.send(held);
          }, wait),
        );
      }
    }
    return ready;
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.held.clear();
    this.lastSentAt.clear();
  }

  private take(id: string): ProviderSubagentInputEvent | undefined {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const held = this.held.get(id);
    if (!held) return undefined;
    this.held.delete(id);
    this.lastSentAt.set(id, this.now());
    return held;
  }

  private get interval(): number {
    return this.options.intervalMs;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function isWorkflowAgentsOnly(event: ProviderSubagentInputEvent): boolean {
  if (event.type !== "upsert" || event.workflowAgents === undefined) return false;
  return Object.keys(event).every(
    (key) => key === "type" || key === "id" || key === "workflowAgents" || key === "timestamp",
  );
}
