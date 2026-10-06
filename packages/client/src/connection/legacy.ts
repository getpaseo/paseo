import { SessionInboundMessageSchema } from "@getpaseo/protocol/messages";
import { LegacyWorkspaces } from "./legacy-workspaces.js";
import { BrowserAutomationHostCapabilitySchema } from "@getpaseo/protocol/browser-automation/capabilities";
import type {
  ServerInfoStatusPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

export type ObservationRequest = { type: SessionInboundMessage["type"] } & Record<string, unknown>;
interface Interest {
  id: string;
  query: ObservationRequest;
}

// COMPAT(ownedSubscriptions): added in v0.8.0; remove after 2027-03-11 once daemon floor >= v0.8.0.
// Legacy directories retain their connection-wide, last-query-wins semantics.
// IDs below identify local listeners, not independent server subscriptions.
export class LegacySubscriptions {
  private readonly interests = new Map<string, Interest>();

  private readonly workspaces: LegacyWorkspaces | null;
  constructor(
    private readonly info: ServerInfoStatusPayload,
    private readonly send: (message: ObservationRequest) => Promise<void>,
    private readonly browserHost: unknown,
  ) {
    this.workspaces = info.features?.workspaceMultiplicity === true ? null : new LegacyWorkspaces();
  }

  normalize(message: SessionOutboundMessage): SessionOutboundMessage {
    return this.workspaces?.normalize(message) ?? message;
  }

  prepareRequest(message: SessionInboundMessage): {
    message: SessionInboundMessage;
    receive(message: SessionOutboundMessage): SessionOutboundMessage;
    finish(): Promise<void>;
  } {
    const identity = {
      message,
      receive: (value: SessionOutboundMessage) => value,
      finish: async () => {},
    };
    const workspaces = this.workspaces;
    if (workspaces && message.type === "fetch_workspaces_request") {
      return {
        ...identity,
        message: SessionInboundMessageSchema.parse({
          type: "fetch_agents_request",
          requestId: message.requestId,
          scope: "active",
          sort: [{ key: "updated_at", direction: "desc" }],
          page: message.page,
          subscribe: message.subscribe,
        }),
        receive: (value) => {
          if (value.type !== "fetch_agents_response") return value;
          if (value.payload.requestId !== message.requestId) return value;
          return {
            type: "fetch_workspaces_response",
            payload: {
              ...value.payload,
              entries: workspaces.read(value.payload.entries, !message.page?.cursor),
              emptyProjects: [],
            },
          };
        },
      };
    }
    if (message.type === "subscribe_terminals_request") {
      return {
        ...identity,
        receive: (value) => {
          if (value.type !== "terminals_changed" || value.payload.cwd !== message.cwd) return value;
          return { ...value, payload: { ...value.payload, requestId: message.requestId } };
        },
      };
    }
    if (message.type === "workspace.label.list.request" && !message.subscribe) {
      return {
        ...identity,
        message: { ...message, subscribe: { subscriptionId: `legacy:${crypto.randomUUID()}` } },
      };
    }
    if (message.type === "checkout.diff.get.request") {
      const subscriptionId = `legacy:${crypto.randomUUID()}`;
      return {
        message: SessionInboundMessageSchema.parse({
          ...message,
          type: "subscribe_checkout_diff_request",
          subscriptionId,
        }),
        receive: (value) => {
          if (value.type !== "subscribe_checkout_diff_response") return value;
          if (value.payload.requestId !== message.requestId) return value;
          return { ...value, type: "checkout.diff.get.response" };
        },
        finish: () => this.send({ type: "unsubscribe_checkout_diff_request", subscriptionId }),
      };
    }
    return identity;
  }

  start(query: ObservationRequest): Interest {
    const interest = { id: `legacy:${crypto.randomUUID()}`, query };
    this.interests.set(interest.id, interest);
    return interest;
  }

  request({ id, query }: Interest): ObservationRequest | null {
    switch (query.type) {
      case "fetch_agents_request":
      case "fetch_workspaces_request":
      case "workspace.label.list.request":
        return { ...query, subscribe: { subscriptionId: id } };
      case "fs.file.subscribe.request":
      case "subscribe_checkout_diff_request":
        return { ...query, subscriptionId: id };
      case "agent.timeline.set_subscription.request":
        if (!this.info.features?.selectiveAgentTimeline) return null;
        return { ...query, agentIds: this.members(query.type, "agentIds") };
      case "session.events.set_subscription.request":
        if (!this.info.features?.explicitEventSubscriptions) return null;
        return {
          ...query,
          events: this.members(query.type, "events").filter(isLegacyEvent),
        };
      case "browser.host.register.request":
        if (!matchesBrowserRegistration(this.browserHost, query)) {
          throw new Error(
            "This daemon requires browser_host registration in the client's hello capabilities",
          );
        }
        return null; // Older hosts register in hello.
      default:
        return query;
    }
  }

  private members(type: ObservationRequest["type"], field: string): string[] {
    const members = new Set<string>();
    for (const interest of this.interests.values()) {
      if (interest.query.type !== type) continue;
      for (const value of interest.query[field] as string[]) members.add(value);
    }
    return [...members].sort();
  }

  release(id: string): ObservationRequest | null {
    const interest = this.interests.get(id);
    if (!interest) return null;
    this.interests.delete(id);
    const { query } = interest;
    switch (query.type) {
      case "agent.timeline.set_subscription.request":
      case "session.events.set_subscription.request":
        return this.request(interest);
      case "fs.file.subscribe.request":
        return { type: "fs.file.unsubscribe.request", subscriptionId: id };
      case "subscribe_checkout_diff_request":
        return { type: "unsubscribe_checkout_diff_request", subscriptionId: id };
      case "subscribe_terminal_request":
        if (
          [...this.interests.values()].some(
            (item) => item.query.type === query.type && item.query.terminalId === query.terminalId,
          )
        )
          return null;
        return { type: "unsubscribe_terminal_request", terminalId: query.terminalId };
      case "subscribe_terminals_request":
        if (
          [...this.interests.values()].some(
            (item) =>
              item.query.type === query.type &&
              item.query.cwd === query.cwd &&
              item.query.workspaceId === query.workspaceId,
          )
        )
          return null;
        return {
          type: "unsubscribe_terminals_request",
          cwd: query.cwd,
          workspaceId: query.workspaceId,
        };
      default:
        // Directory slots have no release RPC. Detach the local listener.
        return null;
    }
  }

  owns(message: SessionOutboundMessage): boolean {
    return [...this.interests.values()].some((interest) => this.matches(interest, message));
  }

  receive(
    message: SessionOutboundMessage,
    deliver: (message: SessionOutboundMessage) => void,
  ): void {
    const updates: SessionOutboundMessage[] = [
      message,
      ...(this.workspaces?.update(message) ?? []),
    ];
    if (message.type === "agent_stream" && message.payload.event.type === "attention_required") {
      const { agentId, event } = message.payload;
      updates.push({
        type: "agent_attention_required",
        payload: {
          agentId,
          reason: event.reason,
          timestamp: event.timestamp,
          shouldNotify: event.shouldNotify,
          ...(event.notification ? { notification: event.notification } : {}),
        },
      });
    }
    for (const update of updates)
      for (const interest of this.interests.values()) {
        if (!this.matches(interest, update)) continue;
        // Normalize at the connection edge; all consumers receive the same handle shape.
        deliver(
          ("payload" in update
            ? { ...update, payload: { ...update.payload, subscriptionId: interest.id } }
            : { ...update, subscriptionId: interest.id }) as SessionOutboundMessage,
        );
      }
  }

  private matches({ id, query }: Interest, message: SessionOutboundMessage): boolean {
    switch (query.type) {
      case "fetch_agents_request":
        return message.type === "agent_update";
      case "fetch_workspaces_request":
        return message.type === "workspace_update";
      case "workspace.label.list.request":
        return message.type === "workspace.label.update";
      case "fs.file.subscribe.request":
        return message.type === "fs.file.update" && message.payload.subscriptionId === id;
      case "subscribe_checkout_diff_request":
        return message.type === "checkout_diff_update" && message.payload.subscriptionId === id;
      case "subscribe_terminals_request":
        return message.type === "terminals_changed" && message.payload.cwd === query.cwd;
      case "subscribe_terminal_request":
        return (
          message.type === "terminal_stream_exit" && message.payload.terminalId === query.terminalId
        );
      case "agent.timeline.set_subscription.request":
        return (
          (message.type === "agent_stream" || message.type === "agent.timeline.replacement") &&
          (query.agentIds as string[]).includes(message.payload.agentId)
        );
      case "session.events.set_subscription.request":
        return (query.events as string[]).includes(
          message.type === "status" ? `status.${message.payload.status}` : message.type,
        );
      case "browser.host.register.request":
        return message.type === "browser.automation.execute.request";
      default:
        return false;
    }
  }
}

function isLegacyEvent(event: string): boolean {
  return [
    "project.update",
    "providers_snapshot_update",
    "agent_attention_required",
    "agent_permission_request",
    "agent_permission_resolved",
  ].includes(event);
}

function matchesBrowserRegistration(advertised: unknown, request: ObservationRequest): boolean {
  const host = BrowserAutomationHostCapabilitySchema.safeParse(advertised);
  if (!host.success) return false;
  if (host.data.hostKind !== request.hostKind) return false;
  for (const command of request.supportedCommands as string[]) {
    if (!host.data.supportedCommands.some((supported) => supported === command)) return false;
  }
  return true;
}
