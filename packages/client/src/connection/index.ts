import type { SessionEventSubscription } from "@getpaseo/protocol/messages";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";

// Protocol support belongs to the installed client. Only browser hosting needs
// a resource supplied by the caller. Keep this exhaustive as the protocol evolves.
export const DEFAULT_CLIENT_CAPABILITIES = {
  [CLIENT_CAPS.allProviders]: true,
  [CLIENT_CAPS.selectiveAgentTimeline]: true,
  [CLIENT_CAPS.reasoningMergeEnum]: true,
  [CLIENT_CAPS.customModeIcons]: true,
  [CLIENT_CAPS.terminalReflowableSnapshot]: true,
  [CLIENT_CAPS.providerSubagents]: true,
  [CLIENT_CAPS.projectUpdates]: true,
  [CLIENT_CAPS.compactProviderSnapshots]: true,
  [CLIENT_CAPS.providerSnapshotReferences]: true,
  [CLIENT_CAPS.timelineReplacementInvalidation]: true,
  [CLIENT_CAPS.timelineNotifications]: true,
  [CLIENT_CAPS.pluginTimelineItems]: true,
  [CLIENT_CAPS.workspaceSetupBlocked]: true,
  [CLIENT_CAPS.explicitEventSubscriptions]: true,
} satisfies Record<Exclude<ClientCapability, typeof CLIENT_CAPS.browserHost>, true>;

/** Owns connection demand, independently of individual facades and React lifetimes. */
export class ConnectionSubscriptions {
  private viewed = new Set<string>();
  private timelines = new Map<string, number>();
  private events: SessionEventSubscription[] = [];

  constructor(
    private readonly send: {
      timelines(agentIds: string[]): Promise<void>;
      events(events: SessionEventSubscription[]): Promise<void>;
      failed(error: unknown): void;
    },
  ) {}

  private agentIds(): string[] {
    return [...new Set([...this.viewed, ...this.timelines.keys()])].sort();
  }

  setViewed(agentIds: string[]): Promise<void> {
    this.viewed = new Set(agentIds);
    return this.send.timelines(this.agentIds());
  }

  observeTimeline(agentId: string): () => void {
    const previous = this.agentIds();
    this.timelines.set(agentId, (this.timelines.get(agentId) ?? 0) + 1);
    this.updateTimelines(previous);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const beforeRelease = this.agentIds();
      const remaining = this.timelines.get(agentId)! - 1;
      if (remaining) this.timelines.set(agentId, remaining);
      else this.timelines.delete(agentId);
      this.updateTimelines(beforeRelease);
    };
  }

  private updateTimelines(previous: string[]): void {
    const next = this.agentIds();
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      void this.send.timelines(next).catch(this.send.failed);
    }
  }

  setEvents(events: SessionEventSubscription[]): void {
    if (JSON.stringify(this.events) === JSON.stringify(events)) return;
    this.events = events;
    void this.send.events(events).catch(this.send.failed);
  }

  restore(): void {
    const agentIds = this.agentIds();
    if (agentIds.length) void this.send.timelines(agentIds).catch(this.send.failed);
    if (this.events.length) void this.send.events(this.events).catch(this.send.failed);
  }
}
