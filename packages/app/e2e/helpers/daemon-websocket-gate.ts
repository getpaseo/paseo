import type { Page, WebSocketRoute } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

export interface DirectoryBootstrapCounts {
  agents: number;
  workspaces: number;
}

export interface DirectoryRequestStartCounts {
  subscribed: DirectoryBootstrapCounts;
  unsubscribed: DirectoryBootstrapCounts;
  total: DirectoryBootstrapCounts;
}

interface ClientRequest {
  type?: unknown;
  direction?: unknown;
  subscribe?: unknown;
  page?: { cursor?: unknown };
  payload?: unknown;
}

interface HeldAgentUpdate {
  agentId: string;
  status: string;
}

function readSessionMessage(message: string | Buffer): ClientRequest | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as {
      type?: unknown;
      message?: ClientRequest;
    };
    return envelope.message ?? envelope;
  } catch {
    return null;
  }
}

function readClientRequest(message: string | Buffer): ClientRequest | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as {
      type?: unknown;
      message?: ClientRequest;
    };
    return envelope.type === "session" ? (envelope.message ?? null) : envelope;
  } catch {
    return null;
  }
}

function directoryForRequest(request: ClientRequest): keyof DirectoryBootstrapCounts | null {
  if (request.page?.cursor) return null;
  if (request.type === "fetch_agents_request") return "agents";
  if (request.type === "fetch_workspaces_request") return "workspaces";
  return null;
}

function stripAssistantMessageId(
  message: string | Buffer,
  enabled: boolean,
  messageType: unknown,
): string | Buffer {
  if (!enabled || messageType !== "agent_stream" || typeof message !== "string") return message;
  const envelope = JSON.parse(message) as {
    message?: { payload?: { event?: { type?: unknown; item?: Record<string, unknown> } } };
    payload?: { event?: { type?: unknown; item?: Record<string, unknown> } };
  };
  const event = (envelope.message?.payload ?? envelope.payload)?.event;
  if (event?.type !== "timeline" || event.item?.type !== "assistant_message") return message;
  delete event.item.messageId;
  return JSON.stringify(envelope);
}

function stripCanonicalSubmittedPrompts(
  message: string | Buffer,
  enabled: boolean,
  messageType: unknown,
): string | Buffer {
  if (!enabled || messageType !== "status" || typeof message !== "string") return message;
  const envelope = JSON.parse(message) as {
    message?: { payload?: { status?: unknown; features?: Record<string, unknown> } };
    payload?: { status?: unknown; features?: Record<string, unknown> };
  };
  const payload = envelope.message?.payload ?? envelope.payload;
  if (payload?.status !== "server_info" || !payload.features) return message;
  delete payload.features.canonicalSubmittedPrompts;
  return JSON.stringify(envelope);
}

function forceTimelineReset(message: string | Buffer, enabled: boolean): string | Buffer {
  if (!enabled || typeof message !== "string") return message;
  const envelope = JSON.parse(message) as {
    message?: { payload?: Record<string, unknown> };
    payload?: Record<string, unknown>;
  };
  const payload = envelope.message?.payload ?? envelope.payload;
  if (!payload) return message;
  payload.epoch = `playwright-reset-${Date.now()}`;
  payload.reset = true;
  return JSON.stringify(envelope);
}

function readAgentStreamEventType(message: ClientRequest | null): string | null {
  if (message?.type !== "agent_stream" || !message.payload || typeof message.payload !== "object") {
    return null;
  }
  const event = (message.payload as { event?: { type?: unknown } }).event;
  return typeof event?.type === "string" ? event.type : null;
}

function readAgentStreamItemType(message: ClientRequest | null): string | null {
  if (message?.type !== "agent_stream" || !message.payload || typeof message.payload !== "object") {
    return null;
  }
  const event = (message.payload as { event?: { type?: unknown; item?: { type?: unknown } } })
    .event;
  return event?.type === "timeline" && typeof event.item?.type === "string"
    ? event.item.type
    : null;
}

function shouldSuppressServerMessage(input: {
  message: ClientRequest | null;
  messageTypes: ReadonlySet<string>;
  agentStreamEventTypes: ReadonlySet<string>;
  agentStreamItemTypes: ReadonlySet<string>;
  suppressAgentStream: boolean;
}): boolean {
  const messageType = typeof input.message?.type === "string" ? input.message.type : null;
  if (messageType && input.messageTypes.has(messageType)) return true;
  if (input.suppressAgentStream && messageType === "agent_stream") return true;
  const itemType = readAgentStreamItemType(input.message);
  if (itemType && input.agentStreamItemTypes.has(itemType)) return true;
  const eventType = readAgentStreamEventType(input.message);
  return Boolean(eventType && input.agentStreamEventTypes.has(eventType));
}

function shouldHoldServerMessage(
  message: ClientRequest | null,
  messageType: string | null,
  agentUpdate: HeldAgentUpdate | null,
): boolean {
  if (message?.type === messageType) return true;
  if (message?.type !== "agent_update" || !agentUpdate) return false;
  const payload = message.payload;
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as { kind?: unknown }).kind !== "upsert"
  ) {
    return false;
  }
  const agent = (payload as { agent?: { id?: unknown; status?: unknown } }).agent;
  return agent?.id === agentUpdate.agentId && agent.status === agentUpdate.status;
}

export async function installDaemonWebSocketGate(page: Page) {
  let acceptingConnections = true;
  let reconnectWithFreshClient = false;
  let suppressAgentStream = false;
  let forceTimelineEpochReset = false;
  let stripAssistantMessageIds = false;
  let stripCanonicalSubmittedPromptsFeature = false;
  let heldClientRequestType: string | null = null;
  let heldClientRequest: { server: WebSocketRoute; message: string | Buffer } | null = null;
  let resolveHeldClientRequest: (() => void) | null = null;
  let heldServerMessageType: string | null = null;
  let heldAgentUpdate: HeldAgentUpdate | null = null;
  let heldServerMessage: { browser: WebSocketRoute; message: string | Buffer } | null = null;
  let resolveHeldServerMessage: (() => void) | null = null;
  const suppressedServerMessageTypes = new Set<string>();
  const suppressedAgentStreamEventTypes = new Set<string>();
  const suppressedAgentStreamItemTypes = new Set<string>();
  const activeSockets = new Set<WebSocketRoute>();
  let latestServer: WebSocketRoute | null = null;
  const directoryStarts: DirectoryRequestStartCounts = {
    subscribed: { agents: 0, workspaces: 0 },
    unsubscribed: { agents: 0, workspaces: 0 },
    total: { agents: 0, workspaces: 0 },
  };
  const clientRequestCounts = new Map<string, number>();
  const timelineRequestCounts = new Map<string, number>();
  const serverMessageCounts = new Map<string, number>();
  const agentStreamEventCounts = new Map<string, number>();
  const agentStreamItemCounts = new Map<string, number>();
  const serverMessageWaiters = new Set<() => void>();

  const recordServerMessage = (message: ClientRequest | null): void => {
    const messageType = typeof message?.type === "string" ? message.type : null;
    const itemType = readAgentStreamItemType(message);
    const eventType = readAgentStreamEventType(message);
    if (messageType)
      serverMessageCounts.set(messageType, (serverMessageCounts.get(messageType) ?? 0) + 1);
    if (itemType)
      agentStreamItemCounts.set(itemType, (agentStreamItemCounts.get(itemType) ?? 0) + 1);
    if (eventType)
      agentStreamEventCounts.set(eventType, (agentStreamEventCounts.get(eventType) ?? 0) + 1);
    if (!messageType && !itemType && !eventType) return;
    for (const resolve of serverMessageWaiters) resolve();
    serverMessageWaiters.clear();
  };

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    if (!acceptingConnections) {
      void ws.close({ code: 1008, reason: "Blocked by reconnect test." });
      return;
    }

    activeSockets.add(ws);
    const server = ws.connectToServer();
    latestServer = server;

    ws.onMessage((message) => {
      if (!acceptingConnections) return;
      if (reconnectWithFreshClient && typeof message === "string") {
        const hello = readClientRequest(message);
        if (hello?.type === "hello") {
          const parsed = JSON.parse(message) as { clientId?: string };
          parsed.clientId = `${parsed.clientId ?? "playwright"}-fresh-${Date.now()}`;
          reconnectWithFreshClient = false;
          server.send(JSON.stringify(parsed));
          return;
        }
      }
      const request = readClientRequest(message);
      if (typeof request?.type === "string") {
        clientRequestCounts.set(request.type, (clientRequestCounts.get(request.type) ?? 0) + 1);
        if (
          request.type === "fetch_agent_timeline_request" &&
          typeof request.direction === "string"
        ) {
          timelineRequestCounts.set(
            request.direction,
            (timelineRequestCounts.get(request.direction) ?? 0) + 1,
          );
        }
        const directory = directoryForRequest(request);
        if (directory) {
          const subscription = request.subscribe === undefined ? "unsubscribed" : "subscribed";
          directoryStarts[subscription][directory] += 1;
          directoryStarts.total[directory] += 1;
        }
      }
      if (request?.type === heldClientRequestType) {
        heldClientRequest = { server, message };
        resolveHeldClientRequest?.();
        resolveHeldClientRequest = null;
        return;
      }
      try {
        server.send(message);
      } catch {
        activeSockets.delete(ws);
      }
    });

    server.onMessage((message) => {
      if (!acceptingConnections) return;
      const serverMessage = readSessionMessage(message);
      let outboundMessage = stripAssistantMessageId(
        message,
        stripAssistantMessageIds,
        serverMessage?.type,
      );
      outboundMessage = stripCanonicalSubmittedPrompts(
        outboundMessage,
        stripCanonicalSubmittedPromptsFeature,
        serverMessage?.type,
      );
      const shouldForceTimelineReset =
        forceTimelineEpochReset && serverMessage?.type === "fetch_agent_timeline_response";
      outboundMessage = forceTimelineReset(outboundMessage, shouldForceTimelineReset);
      if (shouldForceTimelineReset) forceTimelineEpochReset = false;
      recordServerMessage(serverMessage);
      if (shouldHoldServerMessage(serverMessage, heldServerMessageType, heldAgentUpdate)) {
        heldServerMessage = { browser: ws, message: outboundMessage };
        resolveHeldServerMessage?.();
        resolveHeldServerMessage = null;
        return;
      }
      if (
        shouldSuppressServerMessage({
          message: serverMessage,
          messageTypes: suppressedServerMessageTypes,
          agentStreamEventTypes: suppressedAgentStreamEventTypes,
          agentStreamItemTypes: suppressedAgentStreamItemTypes,
          suppressAgentStream,
        })
      )
        return;
      try {
        ws.send(outboundMessage);
      } catch {
        activeSockets.delete(ws);
      }
    });
  });

  return {
    async drop(): Promise<void> {
      acceptingConnections = false;
      const sockets = Array.from(activeSockets);
      activeSockets.clear();
      await Promise.all(
        sockets.map((ws) =>
          ws.close({ code: 1008, reason: "Dropped by reconnect test." }).catch(() => undefined),
        ),
      );
    },
    restore(): void {
      acceptingConnections = true;
    },
    restoreFresh(): void {
      reconnectWithFreshClient = true;
      acceptingConnections = true;
    },
    holdNextClientRequest(type: string): void {
      heldClientRequestType = type;
      heldClientRequest = null;
    },
    waitForHeldClientRequest(): Promise<void> {
      if (heldClientRequest) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveHeldClientRequest = resolve;
      });
    },
    releaseHeldClientRequest(): void {
      if (!heldClientRequest) throw new Error("No held client request to release");
      heldClientRequest.server.send(heldClientRequest.message);
      heldClientRequest = null;
      heldClientRequestType = null;
    },
    holdNextServerMessage(type: string): void {
      heldServerMessageType = type;
      heldAgentUpdate = null;
      heldServerMessage = null;
    },
    holdNextAgentUpdate(agentId: string, status: string): void {
      heldServerMessageType = null;
      heldAgentUpdate = { agentId, status };
      heldServerMessage = null;
    },
    waitForHeldServerMessage(): Promise<void> {
      if (heldServerMessage) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveHeldServerMessage = resolve;
      });
    },
    releaseHeldServerMessage(): void {
      if (!heldServerMessage) throw new Error("No held server message to release");
      heldServerMessage.browser.send(heldServerMessage.message);
      heldServerMessage = null;
      heldServerMessageType = null;
      heldAgentUpdate = null;
    },
    requestTimelineTail(agentId: string): void {
      if (!latestServer) throw new Error("No daemon WebSocket is connected");
      latestServer.send(
        JSON.stringify({
          type: "session",
          message: {
            type: "fetch_agent_timeline_request",
            agentId,
            requestId: `playwright-timeline-${Date.now()}`,
            direction: "tail",
            limit: 0,
            projection: "projected",
          },
        }),
      );
    },
    getHeldTimelineLastItemType(): string | null {
      if (!heldServerMessage) throw new Error("No held server message to inspect");
      const response = readSessionMessage(heldServerMessage.message);
      const payload = response?.payload;
      if (!payload || typeof payload !== "object") return null;
      const entries = (payload as { entries?: unknown }).entries;
      if (!Array.isArray(entries)) return null;
      const last = entries.at(-1) as { item?: { type?: unknown } } | undefined;
      return typeof last?.item?.type === "string" ? last.item.type : null;
    },
    truncateHeldTimelineAfterLast(itemType: string): void {
      if (!heldServerMessage || typeof heldServerMessage.message !== "string") {
        throw new Error("No held text server message to truncate");
      }
      const envelope = JSON.parse(heldServerMessage.message) as {
        message?: { payload?: Record<string, unknown> };
        payload?: Record<string, unknown>;
      };
      const payload = envelope.message?.payload ?? envelope.payload;
      if (!payload) throw new Error("Held message has no payload");
      const entries = payload.entries;
      if (!Array.isArray(entries)) throw new Error("Held message is not a timeline response");
      const index = entries.findLastIndex(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as { item?: { type?: unknown } }).item?.type === itemType,
      );
      if (index < 0) throw new Error(`Timeline response has no ${itemType} item`);
      const retained = entries.slice(0, index + 1) as Array<{ seqEnd?: unknown }>;
      const lastSeq = retained.at(-1)?.seqEnd;
      if (typeof lastSeq !== "number") throw new Error("Timeline entry has no sequence end");
      payload.entries = retained;
      payload.endCursor = { epoch: payload.epoch, seq: lastSeq };
      payload.hasNewer = false;
      if (payload.window && typeof payload.window === "object") {
        (payload.window as Record<string, unknown>).maxSeq = lastSeq;
        (payload.window as Record<string, unknown>).nextSeq = lastSeq + 1;
      }
      heldServerMessage.message = JSON.stringify(envelope);
    },
    setServerMessageSuppressed(type: string, suppressed: boolean): void {
      if (suppressed) {
        suppressedServerMessageTypes.add(type);
      } else {
        suppressedServerMessageTypes.delete(type);
      }
    },
    setAgentStreamEventSuppressed(type: string, suppressed: boolean): void {
      if (suppressed) {
        suppressedAgentStreamEventTypes.add(type);
      } else {
        suppressedAgentStreamEventTypes.delete(type);
      }
    },
    setAgentStreamItemSuppressed(type: string, suppressed: boolean): void {
      if (suppressed) {
        suppressedAgentStreamItemTypes.add(type);
      } else {
        suppressedAgentStreamItemTypes.delete(type);
      }
    },
    setAssistantMessageIdsStripped(stripped: boolean): void {
      stripAssistantMessageIds = stripped;
    },
    setCanonicalSubmittedPromptsStripped(stripped: boolean): void {
      stripCanonicalSubmittedPromptsFeature = stripped;
    },
    setAgentStreamSuppressed(suppressed: boolean): void {
      suppressAgentStream = suppressed;
    },
    forceNextTimelineEpochReset(): void {
      forceTimelineEpochReset = true;
    },
    getDirectoryRequestStartCounts(): DirectoryRequestStartCounts {
      return {
        subscribed: { ...directoryStarts.subscribed },
        unsubscribed: { ...directoryStarts.unsubscribed },
        total: { ...directoryStarts.total },
      };
    },
    getClientRequestCount(type: string): number {
      return clientRequestCounts.get(type) ?? 0;
    },
    getTimelineRequestCount(direction: "tail" | "before" | "after"): number {
      return timelineRequestCounts.get(direction) ?? 0;
    },
    getAgentStreamItemCount(type: string): number {
      return agentStreamItemCounts.get(type) ?? 0;
    },
    async waitForServerMessage(type: string, count = 1): Promise<void> {
      while ((serverMessageCounts.get(type) ?? 0) < count) {
        await new Promise<void>((resolve) => serverMessageWaiters.add(resolve));
      }
    },
    async waitForAgentStreamItem(type: string, count = 1): Promise<void> {
      while ((agentStreamItemCounts.get(type) ?? 0) < count) {
        await new Promise<void>((resolve) => serverMessageWaiters.add(resolve));
      }
    },
    async waitForAgentStreamEvent(type: string, count = 1): Promise<void> {
      while ((agentStreamEventCounts.get(type) ?? 0) < count) {
        await new Promise<void>((resolve) => serverMessageWaiters.add(resolve));
      }
    },
  };
}
