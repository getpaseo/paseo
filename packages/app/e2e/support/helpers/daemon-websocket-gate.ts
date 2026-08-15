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
  mode?: unknown;
  path?: unknown;
  agentId?: unknown;
  text?: unknown;
  activeTurnBehavior?: unknown;
}

interface ServerMessage {
  type?: unknown;
  payload?: {
    initial?: {
      path?: unknown;
    };
    version?: {
      status?: unknown;
      path?: unknown;
    };
  };
}

interface HeldAgentUpdate {
  agentId: string;
  status: string;
}

interface HeldServerMessage {
  browser: WebSocketRoute;
  message: string | Buffer;
  key: string;
  agentStreamFollowers: Array<string | Buffer>;
  blockedAgentId?: string;
}

function readSessionMessage(message: string | Buffer): ClientRequest | null {
  try {
    const envelope = JSON.parse(typeof message === "string" ? message : message.toString()) as {
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

function rewriteShellToolCommand(
  message: string | Buffer,
  command: string | null,
): string | Buffer {
  if (!command || typeof message !== "string") return message;
  const envelope = JSON.parse(message) as {
    message?: { payload?: { event?: { type?: unknown; item?: Record<string, unknown> } } };
    payload?: { event?: { type?: unknown; item?: Record<string, unknown> } };
  };
  const event = (envelope.message?.payload ?? envelope.payload)?.event;
  if (event?.type !== "timeline" || event.item?.type !== "tool_call") return message;
  const detail = event.item.detail;
  if (!detail || typeof detail !== "object" || (detail as { type?: unknown }).type !== "shell") {
    return message;
  }
  (detail as { command?: unknown }).command = command;
  return JSON.stringify(envelope);
}

function readAgentStreamEventType(message: ClientRequest | null): string | null {
  if (message?.type !== "agent_stream" || !message.payload || typeof message.payload !== "object") {
    return null;
  }
  const event = (message.payload as { event?: { type?: unknown } }).event;
  return typeof event?.type === "string" ? event.type : null;
}

function readAgentStreamAgentId(message: ClientRequest | null): string | null {
  if (message?.type !== "agent_stream" || !message.payload || typeof message.payload !== "object") {
    return null;
  }
  const agentId = (message.payload as { agentId?: unknown }).agentId;
  return typeof agentId === "string" ? agentId : null;
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

function matchesToolCall(
  message: ClientRequest | null,
  input: { status: string; command?: string },
): boolean {
  if (readAgentStreamItemType(message) !== "tool_call") return false;
  const event = (
    message?.payload as
      | {
          event?: { item?: { status?: unknown; detail?: { command?: unknown } } };
        }
      | undefined
  )?.event;
  return (
    event?.item?.status === input.status &&
    (input.command === undefined || event.item.detail?.command === input.command)
  );
}

function matchesShellToolCall(message: ClientRequest | null, status: string): boolean {
  if (readAgentStreamItemType(message) !== "tool_call") return false;
  const event = (
    message?.payload as
      | {
          event?: { item?: { status?: unknown; detail?: { type?: unknown } } };
        }
      | undefined
  )?.event;
  return event?.item?.status === status && event.item.detail?.type === "shell";
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

function serverMessageKey(type: string): string {
  return `message:${type}`;
}

function agentStreamEventKey(type: string): string {
  return `agent-stream-event:${type}`;
}

function agentStreamItemKey(type: string): string {
  return `agent-stream-item:${type}`;
}

function agentUpdateKey(agentId: string, status: string): string {
  return `agent-update:${agentId}:${status}`;
}

function matchesAgentUpdate(message: ClientRequest | null, agentUpdate: HeldAgentUpdate): boolean {
  if (message?.type !== "agent_update") return false;
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

function recordClientRequest(
  request: ClientRequest | null,
  clientRequestCounts: Map<string, number>,
  timelineRequestCounts: Map<string, number>,
  directoryStarts: DirectoryRequestStartCounts,
): void {
  if (typeof request?.type !== "string") return;
  clientRequestCounts.set(request.type, (clientRequestCounts.get(request.type) ?? 0) + 1);
  if (request.type === "fetch_agent_timeline_request" && typeof request.direction === "string") {
    timelineRequestCounts.set(
      request.direction,
      (timelineRequestCounts.get(request.direction) ?? 0) + 1,
    );
  }
  const directory = directoryForRequest(request);
  if (!directory) return;
  const subscription = request.subscribe === undefined ? "unsubscribed" : "subscribed";
  directoryStarts[subscription][directory] += 1;
  directoryStarts.total[directory] += 1;
}

export async function installDaemonWebSocketGate(page: Page) {
  let acceptingConnections = true;
  let reconnectWithFreshClient = false;
  let suppressAgentStream = false;
  let forceTimelineEpochReset = false;
  let stripAssistantMessageIds = false;
  let stripCanonicalSubmittedPromptsFeature = false;
  let shellToolCommandOverride: string | null = null;
  let heldClientRequestType: string | null = null;
  let heldClientRequest: { server: WebSocketRoute; message: string | Buffer } | null = null;
  let resolveHeldClientRequest: (() => void) | null = null;
  const pendingServerMessageHolds = new Map<string, (message: ClientRequest | null) => boolean>();
  const heldServerMessages: HeldServerMessage[] = [];
  const heldServerMessageWaiters = new Set<() => void>();
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
  const clientRequests = new Map<string, ClientRequest[]>();
  const timelineRequestCounts = new Map<string, number>();
  const serverMessageCounts = new Map<string, number>();
  const agentStreamEventCounts = new Map<string, number>();
  const agentStreamItemCounts = new Map<string, number>();
  const serverMessageWaiters = new Set<() => void>();
  const subscribedFilePaths = new Set<string>();
  const fileSubscriptionWaiters = new Map<string, () => void>();
  const observedFileUpdates = new Set<string>();
  const fileUpdateWaiters = new Map<string, () => void>();
  let fileReadPathToHold: string | null = null;
  let heldFileReads: Array<() => void> = [];
  let resolveHeldFileRead: (() => void) | null = null;
  let heldFileReadPromise = Promise.resolve();
  let readyFileUpdatePathToHold: string | null = null;
  let heldReadyFileUpdate: (() => void) | null = null;
  let resolveHeldReadyFileUpdate: (() => void) | null = null;
  let heldReadyFileUpdatePromise = Promise.resolve();
  const recordFileUpdate = (message: ServerMessage): void => {
    if (
      message.type !== "fs.file.update" ||
      typeof message.payload?.version?.status !== "string" ||
      typeof message.payload.version.path !== "string"
    ) {
      return;
    }
    const key = `${message.payload.version.path}:${message.payload.version.status}`;
    observedFileUpdates.add(key);
    fileUpdateWaiters.get(key)?.();
    fileUpdateWaiters.delete(key);
  };

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

  const observeFileMessage = (message: ServerMessage | null): void => {
    if (
      message?.type === "fs.file.subscribe.response" &&
      typeof message.payload?.initial?.path === "string"
    ) {
      const path = message.payload.initial.path;
      subscribedFilePaths.add(path);
      fileSubscriptionWaiters.get(path)?.();
      fileSubscriptionWaiters.delete(path);
    }
    if (message) recordFileUpdate(message);
  };

  const holdServerMessage = (input: {
    browser: WebSocketRoute;
    message: string | Buffer;
    parsed: ClientRequest | null;
  }): boolean => {
    const agentId = readAgentStreamAgentId(input.parsed);
    const blocked = agentId
      ? heldServerMessages.find((held) => held.blockedAgentId === agentId)
      : undefined;
    const suppressed = shouldSuppressServerMessage({
      message: input.parsed,
      messageTypes: suppressedServerMessageTypes,
      agentStreamEventTypes: suppressedAgentStreamEventTypes,
      agentStreamItemTypes: suppressedAgentStreamItemTypes,
      suppressAgentStream,
    });
    if (blocked) {
      if (!suppressed) blocked.agentStreamFollowers.push(input.message);
      return true;
    }
    const matchedHold = Array.from(pendingServerMessageHolds).find(([, matches]) =>
      matches(input.parsed),
    );
    if (!matchedHold) return suppressed;
    const [key] = matchedHold;
    pendingServerMessageHolds.delete(key);
    heldServerMessages.push({
      browser: input.browser,
      message: input.message,
      key,
      agentStreamFollowers: [],
      blockedAgentId:
        readAgentStreamEventType(input.parsed) === "turn_started"
          ? (agentId ?? undefined)
          : undefined,
    });
    for (const resolve of heldServerMessageWaiters) resolve();
    heldServerMessageWaiters.clear();
    return true;
  };

  const holdReadyFileUpdate = (
    browser: WebSocketRoute,
    message: string | Buffer,
    fileMessage: ServerMessage | null,
  ): boolean => {
    if (
      fileMessage?.type !== "fs.file.update" ||
      fileMessage.payload?.version?.status !== "ready" ||
      fileMessage.payload.version.path !== readyFileUpdatePathToHold ||
      heldReadyFileUpdate
    ) {
      return false;
    }
    heldReadyFileUpdate = () => browser.send(message);
    resolveHeldReadyFileUpdate?.();
    return true;
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
      recordClientRequest(request, clientRequestCounts, timelineRequestCounts, directoryStarts);
      if (typeof request?.type === "string") {
        const requests = clientRequests.get(request.type) ?? [];
        requests.push(request);
        clientRequests.set(request.type, requests);
      }
      if (request?.type === heldClientRequestType) {
        heldClientRequest = { server, message };
        resolveHeldClientRequest?.();
        resolveHeldClientRequest = null;
        return;
      }
      if (
        request?.type === "file_explorer_request" &&
        request.mode === "file" &&
        request.path === fileReadPathToHold
      ) {
        heldFileReads.push(() => server.send(message));
        resolveHeldFileRead?.();
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
      const fileMessage = serverMessage as ServerMessage | null;
      observeFileMessage(fileMessage);
      let outboundMessage = stripAssistantMessageId(
        message,
        stripAssistantMessageIds,
        serverMessage?.type,
      );
      outboundMessage = rewriteShellToolCommand(outboundMessage, shellToolCommandOverride);
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
      if (holdServerMessage({ browser: ws, message: outboundMessage, parsed: serverMessage }))
        return;
      if (holdReadyFileUpdate(ws, outboundMessage, fileMessage)) return;
      try {
        ws.send(outboundMessage);
      } catch {
        activeSockets.delete(ws);
      }
    });
  });

  return {
    waitForFileSubscription(path: string): Promise<void> {
      if (subscribedFilePaths.has(path)) return Promise.resolve();
      return new Promise((resolve) => fileSubscriptionWaiters.set(path, resolve));
    },
    waitForFileUpdate(path: string, status: "ready" | "missing" | "error"): Promise<void> {
      const key = `${path}:${status}`;
      if (observedFileUpdates.has(key)) return Promise.resolve();
      return new Promise((resolve) => fileUpdateWaiters.set(key, resolve));
    },
    holdFileReads(path: string): void {
      fileReadPathToHold = path;
      heldFileReads = [];
      heldFileReadPromise = new Promise((resolve) => {
        resolveHeldFileRead = resolve;
      });
    },
    waitForHeldFileRead(): Promise<void> {
      return heldFileReadPromise;
    },
    releaseHeldFileRead(): void {
      const forwards = heldFileReads;
      heldFileReads = [];
      fileReadPathToHold = null;
      resolveHeldFileRead = null;
      for (const forward of forwards) forward();
    },
    holdNextReadyFileUpdate(path: string): void {
      readyFileUpdatePathToHold = path;
      heldReadyFileUpdate = null;
      heldReadyFileUpdatePromise = new Promise((resolve) => {
        resolveHeldReadyFileUpdate = resolve;
      });
    },
    waitForHeldReadyFileUpdate(): Promise<void> {
      return heldReadyFileUpdatePromise;
    },
    releaseHeldReadyFileUpdate(): void {
      const forward = heldReadyFileUpdate;
      heldReadyFileUpdate = null;
      readyFileUpdatePathToHold = null;
      resolveHeldReadyFileUpdate = null;
      forward?.();
    },
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
      pendingServerMessageHolds.set(serverMessageKey(type), (message) => message?.type === type);
    },
    holdNextAgentUpdate(agentId: string, status: string): void {
      const heldAgentUpdate = { agentId, status };
      pendingServerMessageHolds.set(agentUpdateKey(agentId, status), (message) =>
        matchesAgentUpdate(message, heldAgentUpdate),
      );
    },
    holdNextAgentStreamEvent(type: string): void {
      pendingServerMessageHolds.set(
        agentStreamEventKey(type),
        (message) => readAgentStreamEventType(message) === type,
      );
    },
    holdNextAgentStreamItem(type: string): void {
      pendingServerMessageHolds.set(
        agentStreamItemKey(type),
        (message) => readAgentStreamItemType(message) === type,
      );
    },
    holdNextToolCall(input: { status: string; command?: string }): void {
      pendingServerMessageHolds.set(`tool-call:${input.status}:${input.command ?? ""}`, (message) =>
        matchesToolCall(message, input),
      );
    },
    holdNextShellToolCall(status: string): void {
      pendingServerMessageHolds.set(`shell-tool-call:${status}`, (message) =>
        matchesShellToolCall(message, status),
      );
    },
    async waitForHeldServerMessage(type?: string): Promise<void> {
      const key = type ? serverMessageKey(type) : null;
      while (!heldServerMessages.some((message) => key === null || message.key === key)) {
        await new Promise<void>((resolve) => heldServerMessageWaiters.add(resolve));
      }
    },
    releaseHeldServerMessage(type?: string): void {
      const key = type ? serverMessageKey(type) : null;
      const index = heldServerMessages.findIndex((message) => key === null || message.key === key);
      const [heldServerMessage] = index >= 0 ? heldServerMessages.splice(index, 1) : [];
      if (!heldServerMessage) throw new Error("No held server message to release");
      heldServerMessage.browser.send(heldServerMessage.message);
      for (const follower of heldServerMessage.agentStreamFollowers) {
        heldServerMessage.browser.send(follower);
      }
    },
    async waitForHeldAgentUpdate(agentId: string, status: string): Promise<void> {
      const key = agentUpdateKey(agentId, status);
      while (!heldServerMessages.some((message) => message.key === key)) {
        await new Promise<void>((resolve) => heldServerMessageWaiters.add(resolve));
      }
    },
    releaseHeldAgentUpdate(agentId: string, status: string): void {
      const key = agentUpdateKey(agentId, status);
      const index = heldServerMessages.findIndex((message) => message.key === key);
      const [heldServerMessage] = index >= 0 ? heldServerMessages.splice(index, 1) : [];
      if (!heldServerMessage) throw new Error("No held agent update to release");
      heldServerMessage.browser.send(heldServerMessage.message);
      for (const follower of heldServerMessage.agentStreamFollowers) {
        heldServerMessage.browser.send(follower);
      }
    },
    async waitForHeldAgentStreamEvent(type: string): Promise<void> {
      const key = agentStreamEventKey(type);
      while (!heldServerMessages.some((message) => message.key === key)) {
        await new Promise<void>((resolve) => heldServerMessageWaiters.add(resolve));
      }
    },
    releaseHeldAgentStreamEvent(type: string): void {
      const key = agentStreamEventKey(type);
      const index = heldServerMessages.findIndex((message) => message.key === key);
      const [heldServerMessage] = index >= 0 ? heldServerMessages.splice(index, 1) : [];
      if (!heldServerMessage) throw new Error("No held agent stream event to release");
      heldServerMessage.browser.send(heldServerMessage.message);
      for (const follower of heldServerMessage.agentStreamFollowers) {
        heldServerMessage.browser.send(follower);
      }
    },
    async waitForHeldAgentStreamItem(type: string): Promise<void> {
      const key = agentStreamItemKey(type);
      while (!heldServerMessages.some((message) => message.key === key)) {
        await new Promise<void>((resolve) => heldServerMessageWaiters.add(resolve));
      }
    },
    releaseHeldAgentStreamItem(type: string): void {
      const key = agentStreamItemKey(type);
      const index = heldServerMessages.findIndex((message) => message.key === key);
      const [heldServerMessage] = index >= 0 ? heldServerMessages.splice(index, 1) : [];
      if (!heldServerMessage) throw new Error("No held agent stream item to release");
      heldServerMessage.browser.send(heldServerMessage.message);
      for (const follower of heldServerMessage.agentStreamFollowers) {
        heldServerMessage.browser.send(follower);
      }
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
      const heldServerMessage = heldServerMessages[0];
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
      const heldServerMessage = heldServerMessages[0];
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
    setShellToolCommandOverride(command: string | null): void {
      shellToolCommandOverride = command;
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
    getClientRequests(type: string): ReadonlyArray<ClientRequest> {
      return [...(clientRequests.get(type) ?? [])];
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
