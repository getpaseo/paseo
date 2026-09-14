export { OwnedSubscriptions, type OwnedSubscription, type SubscriptionObserver } from "./owned.js";
import {
  OwnedSubscriptions,
  type OwnedSubscription,
  type OwnedSubscriptionsHost,
} from "./owned.js";
import { LegacySubscriptions, type ObservationRequest } from "./legacy.js";
import {
  type SessionInboundMessage,
  type SessionOutboundMessage,
  type ServerInfoStatusPayload,
} from "@getpaseo/protocol/messages";
import { CLIENT_CAPS, type ClientCapability } from "@getpaseo/protocol/client-capabilities";

export class ConnectionSubscriptions extends OwnedSubscriptions {
  private legacy: LegacySubscriptions | null = null;

  constructor(
    private readonly connection: OwnedSubscriptionsHost & {
      send(message: ObservationRequest): Promise<void>;
    },
  ) {
    super({
      ...connection,
      release: async (id) => {
        if (!this.legacy) return connection.release(id);
        const message = this.legacy.release(id);
        if (message) await connection.send(message);
      },
    });
  }

  override restore(
    info?: ServerInfoStatusPayload,
    capabilities?: Partial<Record<ClientCapability, unknown>>,
  ): void {
    if (info) {
      const clientCapabilities = capabilities ?? DEFAULT_CLIENT_CAPABILITIES;
      const owned =
        info.features?.ownedSubscriptions === true &&
        clientCapabilities[CLIENT_CAPS.ownedSubscriptions] === true;
      this.legacy = null;
      if (!owned) {
        this.legacy = new LegacySubscriptions(
          info,
          this.connection.send,
          capabilities?.[CLIENT_CAPS.browserHost],
        );
      }
    }
    super.restore();
  }

  override disconnected(): void {
    super.disconnected();
    this.legacy = null;
  }

  observeRequest<T>(
    query: ObservationRequest,
    request: (query: ObservationRequest, accept: (snapshot: T) => void) => Promise<T>,
    signal?: AbortSignal,
    failed?: () => void,
  ): OwnedSubscription<T> {
    return super.observe(
      async (accept) => {
        const legacy = this.legacy;
        if (!legacy) return request(query, accept);
        const interest = legacy.start(query);
        const snapshot = (payload: T): T & { subscriptionId: string } => ({
          ...payload,
          subscriptionId: interest.id,
        });
        try {
          const message = legacy.request(interest);
          if (!message) {
            // Broadcast-era hosts have no acknowledgement. Readiness means the
            // local listener is attached; no server membership is being claimed.
            const value = snapshot({
              requestId: interest.id,
              ...(query.type === "agent.timeline.set_subscription.request"
                ? { agentIds: query.agentIds }
                : {}),
            } as T);
            accept(value);
            return value;
          }
          return snapshot(await request(message, (payload) => accept(snapshot(payload))));
        } catch (error) {
          const release = legacy.release(interest.id);
          if (release && this.legacy === legacy)
            await this.connection.send(release).catch(this.connection.failed);
          throw error;
        }
      },
      signal,
      failed,
    );
  }

  override owns(message: SessionOutboundMessage): boolean {
    return this.legacy ? this.legacy.owns(message) : super.owns(message);
  }

  override receive(message: SessionOutboundMessage): void {
    if (this.legacy) this.legacy.receive(message, (update) => super.receive(update));
    else super.receive(message);
  }

  normalize(message: SessionOutboundMessage): SessionOutboundMessage {
    return this.legacy?.normalize(message) ?? message;
  }

  prepareRequest(message: SessionInboundMessage) {
    return (
      this.legacy?.prepareRequest(message) ?? {
        message,
        receive: (value: SessionOutboundMessage) => value,
        finish: async () => {},
      }
    );
  }
}

// Protocol support belongs to the installed client. Only browser hosting needs
// a resource supplied by the caller. Keep this exhaustive as the protocol evolves.
export const DEFAULT_CLIENT_CAPABILITIES = {
  [CLIENT_CAPS.ownedSubscriptions]: true,
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

/** Calling releases demand; ready waits for membership, or local attachment on broadcast hosts. */
export type TimelineSubscription = (() => void) & {
  readonly ready: Promise<void>;
  readonly subscriptionId: string | null;
  release(): Promise<void>;
};
