import type { Page } from "@playwright/test";
import { loadSessionMessageReaders } from "./new-workspace";
import { daemonWsRoutePattern, wsRoutePatternForPort } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface CreatedAgentTimelineGate {
  release(): void;
  waitForCreatedAgent(): Promise<string>;
  waitForDelayedResponse(): Promise<void>;
  waitForForwardedResponse(): Promise<void>;
}

export interface AgentTimelineResponseGate {
  release(): void;
  waitForDelayedResponse(): Promise<void>;
}

export interface OlderTimelinePagesGate {
  getRequestCount(): number;
  getRepeatedEntryCount(): number;
  getOwnedEntryCountContaining(text: string): number;
  releasePage(pageNumber: number): void;
  waitForRequestCount(count: number): Promise<void>;
}

export interface DaemonHydrationGate {
  release(): void;
}

export interface RewindCompletionGate {
  clearTimelineStreamCount(): void;
  release(): void;
  timelineStreamCount(): number;
  waitForDelayedResponse(): Promise<void>;
}

export interface PromptJumpRequestTracker {
  requests(): Array<{ cursorSeq: number | null; limit: number | null; mergeWindow: boolean }>;
}

export async function trackPromptJumpRequests(
  page: Page,
  agentId: string,
): Promise<PromptJumpRequestTracker> {
  const seen: Array<{ cursorSeq: number | null; limit: number | null; mergeWindow: boolean }> = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (
        sessionMessage?.type === "fetch_agent_timeline_request" &&
        sessionMessage.agentId === agentId &&
        sessionMessage.direction === "before" &&
        sessionMessage.mergeWindow === true
      ) {
        const cursor = sessionMessage.cursor as { seq?: unknown } | undefined;
        seen.push({
          cursorSeq: typeof cursor?.seq === "number" ? cursor.seq : null,
          limit: typeof sessionMessage.limit === "number" ? sessionMessage.limit : null,
          mergeWindow: true,
        });
      }
      server.send(message);
    });
    server.onMessage((message) => ws.send(message));
  });
  return {
    requests: () => [...seen],
  };
}

export interface BootstrapTimelineGate extends AgentTimelineResponseGate {
  releaseCatchUp(): void;
  waitForDelayedCatchUp(): Promise<void>;
}

function parseWebSocketJson(message: WebSocketMessage): unknown {
  const rawMessage = typeof message === "string" ? message : message.toString("utf8");
  try {
    return JSON.parse(rawMessage);
  } catch {
    return null;
  }
}

function getSessionMessage(message: WebSocketMessage): Record<string, unknown> | null {
  const envelope = parseWebSocketJson(message);
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const maybeEnvelope = envelope as { type?: unknown; message?: unknown };
  if (maybeEnvelope.type !== "session" || !maybeEnvelope.message) {
    return null;
  }
  if (typeof maybeEnvelope.message !== "object") {
    return null;
  }
  return maybeEnvelope.message as Record<string, unknown>;
}

function getPayload(message: Record<string, unknown>): Record<string, unknown> | null {
  return message.payload && typeof message.payload === "object"
    ? (message.payload as Record<string, unknown>)
    : null;
}

interface ObservedTimelineEntry {
  seqStart: number;
  seqEnd: number;
  item: { type: string };
}

function readTimelineEntries(payload: Record<string, unknown>): ObservedTimelineEntry[] {
  if (!Array.isArray(payload.entries)) return [];
  return payload.entries.filter((entry): entry is ObservedTimelineEntry => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<ObservedTimelineEntry>;
    return (
      typeof candidate.seqStart === "number" &&
      typeof candidate.seqEnd === "number" &&
      typeof candidate.item?.type === "string"
    );
  });
}

function readCursorSeq(cursor: unknown): number | undefined {
  if (!cursor || typeof cursor !== "object") return undefined;
  const seq = (cursor as { seq?: unknown }).seq;
  return typeof seq === "number" ? seq : undefined;
}

function recordOwnedTimelineEntries(
  payload: Record<string, unknown>,
  ownedEntries: Map<string, string>,
): void {
  const pageStartSeq = readCursorSeq(payload.startCursor);
  const pageEndSeq = readCursorSeq(payload.endCursor);
  for (const entry of readTimelineEntries(payload)) {
    const belongsToPage =
      payload.direction === "tail" ||
      (pageStartSeq !== undefined &&
        pageEndSeq !== undefined &&
        entry.seqStart >= pageStartSeq &&
        entry.seqStart <= pageEndSeq);
    if (!belongsToPage) continue;
    ownedEntries.set(`${entry.seqStart}:${entry.seqEnd}`, JSON.stringify(entry.item));
  }
}

function recordRepeatedTimelineEntries(
  payload: Record<string, unknown>,
  entryKeys: Set<string>,
): number {
  let repeats = 0;
  for (const entry of readTimelineEntries(payload)) {
    const key = `${entry.seqStart}:${entry.seqEnd}:${entry.item.type}`;
    if (entryKeys.has(key)) repeats += 1;
    else entryKeys.add(key);
  }
  return repeats;
}

export async function holdDaemonHydration(page: Page): Promise<DaemonHydrationGate> {
  let released = false;
  const delayedForwards: Array<() => void> = [];

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      if (released) {
        ws.send(message);
        return;
      }
      delayedForwards.push(() => ws.send(message));
    });
  });

  return {
    release() {
      released = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
  };
}

export async function holdRewindCompletion(
  page: Page,
  agentId: string,
): Promise<RewindCompletionGate> {
  let released = false;
  let timelineStreamCount = 0;
  const delayedForwards: Array<() => void> = [];
  let resolveDelayedResponse: (() => void) | null = null;
  const delayedResponse = new Promise<void>((resolve) => {
    resolveDelayedResponse = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage ? getPayload(sessionMessage) : null;
      const streamEvent = payload?.event;
      if (
        sessionMessage?.type === "agent_stream" &&
        payload?.agentId === agentId &&
        streamEvent &&
        typeof streamEvent === "object" &&
        (streamEvent as { type?: unknown }).type === "timeline"
      ) {
        timelineStreamCount += 1;
      }
      if (
        !released &&
        (sessionMessage?.type === "agent.rewind.response" ||
          sessionMessage?.type === "agent.timeline.replacement") &&
        payload?.agentId === agentId
      ) {
        // The replacement also signals completion and removes the rewound row/menu.
        // Hold it with the response so the pending-state assertion observes a pending rewind.
        delayedForwards.push(() => ws.send(message));
        if (sessionMessage.type === "agent.rewind.response") resolveDelayedResponse?.();
        return;
      }
      ws.send(message);
    });
  });

  return {
    clearTimelineStreamCount() {
      timelineStreamCount = 0;
    },
    release() {
      released = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
    timelineStreamCount: () => timelineStreamCount,
    waitForDelayedResponse: () => delayedResponse,
  };
}

export async function delayCreatedAgentInitialTailResponse(
  page: Page,
): Promise<CreatedAgentTimelineGate> {
  const frames = await loadSessionMessageReaders();
  let createdAgentId: string | null = null;
  let releaseRequested = false;
  let delayedResponseSeen = false;
  const delayedForwards: Array<() => void> = [];
  let resolveCreatedAgent: ((agentId: string) => void) | null = null;
  let resolveDelayedResponse: (() => void) | null = null;
  let resolveForwardedResponse: (() => void) | null = null;
  const createdAgentSeen = new Promise<string>((resolve) => {
    resolveCreatedAgent = resolve;
  });
  const delayedResponse = new Promise<void>((resolve) => {
    resolveDelayedResponse = resolve;
  });
  const forwardedResponse = new Promise<void>((resolve) => {
    resolveForwardedResponse = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    const forwardToClient = (message: WebSocketMessage) => {
      ws.send(message);
      resolveForwardedResponse?.();
    };

    ws.onMessage((message) => {
      server.send(message);
    });

    server.onMessage((message) => {
      const sessionMessage = frames.server(message);
      let createdId: unknown;
      if (sessionMessage?.type === "agent.create.response") {
        createdId = sessionMessage.payload.agent?.id;
      } else if (
        sessionMessage?.type === "status" &&
        sessionMessage.payload.status === "agent_created"
      ) {
        createdId = sessionMessage.payload.agentId;
      }
      if (typeof createdId === "string") {
        createdAgentId = createdId;
        resolveCreatedAgent?.(createdId);
      }

      if (sessionMessage?.type === "fetch_agent_timeline_response") {
        const agentId = sessionMessage.payload.agentId;
        const direction = sessionMessage.payload.direction;
        if (
          !delayedResponseSeen &&
          typeof agentId === "string" &&
          agentId === createdAgentId &&
          direction === "tail"
        ) {
          delayedResponseSeen = true;
          resolveDelayedResponse?.();
          if (releaseRequested) {
            forwardToClient(message);
            return;
          }
          delayedForwards.push(() => forwardToClient(message));
          return;
        }
      }

      ws.send(message);
    });
  });

  return {
    release() {
      releaseRequested = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
    waitForCreatedAgent: () => createdAgentSeen,
    waitForDelayedResponse: () => delayedResponse,
    waitForForwardedResponse: () => forwardedResponse,
  };
}

export async function delayAgentOlderTimelineResponse(
  page: Page,
  agentId: string,
): Promise<AgentTimelineResponseGate> {
  return delayAgentTimelineResponse(page, agentId, "before");
}

export async function holdAgentOlderTimelinePages(
  page: Page,
  agentId: string,
  daemonPort?: number,
): Promise<OlderTimelinePagesGate> {
  let requestCount = 0;
  let responseCount = 0;
  let repeatedEntryCount = 0;
  const entryKeys = new Set<string>();
  const ownedEntries = new Map<string, string>();
  const releasedPages = new Set<number>();
  const delayedForwards = new Map<number, Array<() => void>>();
  const requestWaiters = new Map<number, Array<() => void>>();

  const resolveRequestWaiters = () => {
    for (const [count, resolvers] of requestWaiters) {
      if (requestCount < count) continue;
      requestWaiters.delete(count);
      for (const resolve of resolvers) resolve();
    }
  };

  const routePattern =
    daemonPort === undefined ? daemonWsRoutePattern() : wsRoutePatternForPort(String(daemonPort));
  await page.routeWebSocket(routePattern, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      if (
        sessionMessage?.type === "fetch_agent_timeline_request" &&
        sessionMessage.agentId === agentId &&
        sessionMessage.direction === "before"
      ) {
        requestCount += 1;
        resolveRequestWaiters();
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage ? getPayload(sessionMessage) : null;
      if (
        sessionMessage?.type === "fetch_agent_timeline_response" &&
        payload?.agentId === agentId &&
        (payload.direction === "tail" || payload.direction === "before")
      ) {
        recordOwnedTimelineEntries(payload, ownedEntries);
      }
      if (
        sessionMessage?.type === "fetch_agent_timeline_response" &&
        payload?.agentId === agentId &&
        payload.direction === "before"
      ) {
        responseCount += 1;
        repeatedEntryCount += recordRepeatedTimelineEntries(payload, entryKeys);
        const pageNumber = responseCount;
        if (releasedPages.has(pageNumber)) {
          ws.send(message);
          return;
        }
        const forwards = delayedForwards.get(pageNumber) ?? [];
        forwards.push(() => ws.send(message));
        delayedForwards.set(pageNumber, forwards);
        return;
      }
      ws.send(message);
    });
  });

  return {
    getRequestCount: () => requestCount,
    getRepeatedEntryCount: () => repeatedEntryCount,
    getOwnedEntryCountContaining: (value) =>
      [...ownedEntries.values()].filter((text) => text.includes(value)).length,
    releasePage(pageNumber) {
      releasedPages.add(pageNumber);
      for (const forward of delayedForwards.get(pageNumber) ?? []) forward();
      delayedForwards.delete(pageNumber);
    },
    waitForRequestCount(count) {
      if (requestCount >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const resolvers = requestWaiters.get(count) ?? [];
        resolvers.push(resolve);
        requestWaiters.set(count, resolvers);
      });
    },
  };
}

export async function delayAgentBootstrapTailResponse(
  page: Page,
  agentId: string,
): Promise<BootstrapTimelineGate> {
  let tailReleased = false;
  let catchUpReleased = false;
  const delayedTailForwards: Array<() => void> = [];
  const delayedCatchUpForwards: Array<() => void> = [];
  let resolveDelayedTail: (() => void) | null = null;
  let resolveDelayedCatchUp: (() => void) | null = null;
  const delayedTail = new Promise<void>((resolve) => {
    resolveDelayedTail = resolve;
  });
  const delayedCatchUp = new Promise<void>((resolve) => {
    resolveDelayedCatchUp = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage ? getPayload(sessionMessage) : null;
      const isTimelineResponse =
        sessionMessage?.type === "fetch_agent_timeline_response" && payload?.agentId === agentId;
      if (isTimelineResponse && payload.direction === "tail") {
        resolveDelayedTail?.();
        if (tailReleased) ws.send(message);
        else delayedTailForwards.push(() => ws.send(message));
        return;
      }
      if (isTimelineResponse && payload.direction === "after") {
        resolveDelayedCatchUp?.();
        if (catchUpReleased) ws.send(message);
        else delayedCatchUpForwards.push(() => ws.send(message));
        return;
      }
      ws.send(message);
    });
  });

  return {
    release() {
      tailReleased = true;
      for (const forward of delayedTailForwards.splice(0)) forward();
    },
    releaseCatchUp() {
      catchUpReleased = true;
      for (const forward of delayedCatchUpForwards.splice(0)) forward();
    },
    waitForDelayedResponse: () => delayedTail,
    waitForDelayedCatchUp: () => delayedCatchUp,
  };
}

async function delayAgentTimelineResponse(
  page: Page,
  agentId: string,
  direction: "before" | "tail",
): Promise<AgentTimelineResponseGate> {
  let releaseRequested = false;
  let delayedResponseSeen = false;
  const delayedForwards: Array<() => void> = [];
  let resolveDelayedResponse: (() => void) | null = null;
  const delayedResponse = new Promise<void>((resolve) => {
    resolveDelayedResponse = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      server.send(message);
    });
    server.onMessage((message) => {
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage ? getPayload(sessionMessage) : null;
      if (
        !delayedResponseSeen &&
        sessionMessage?.type === "fetch_agent_timeline_response" &&
        payload?.agentId === agentId &&
        payload.direction === direction
      ) {
        delayedResponseSeen = true;
        resolveDelayedResponse?.();
        if (releaseRequested) {
          ws.send(message);
          return;
        }
        delayedForwards.push(() => ws.send(message));
        return;
      }
      ws.send(message);
    });
  });

  return {
    release() {
      releaseRequested = true;
      for (const forward of delayedForwards.splice(0)) {
        forward();
      }
    },
    waitForDelayedResponse: () => delayedResponse,
  };
}

/** Holds real incoming frames so intermediate rendering assertions do not race the producer. */
export async function holdAssistantStream(page: Page, agentId: string) {
  const pending: Array<{ forward(): void; text: string }> = [];
  let holding = false;
  let released = false;
  let forwardedText = "";
  let notifyFrame: (() => void) | undefined;
  let notifyInitialTimeline!: () => void;
  const initialTimeline = new Promise<void>((resolve) => {
    notifyInitialTimeline = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => server.send(message));
    server.onMessage((message) => {
      const session = getSessionMessage(message);
      const payload = session ? getPayload(session) : null;
      if (session?.type === "fetch_agent_timeline_response" && payload?.agentId === agentId) {
        notifyInitialTimeline();
      }
      const event = payload?.event as
        | { type?: string; item?: { type?: string; text?: string } }
        | undefined;
      const text =
        session?.type === "agent_stream" &&
        payload?.agentId === agentId &&
        event?.type === "timeline" &&
        event.item?.type === "assistant_message"
          ? (event.item.text ?? "")
          : "";
      if (text) holding = true;
      if (holding && !released) {
        pending.push({ forward: () => ws.send(message), text });
        notifyFrame?.();
      } else {
        ws.send(message);
      }
    });
  });

  return {
    waitForInitialTimeline: () => initialTimeline,
    async showThrough(prefix: string): Promise<void> {
      while (forwardedText.length < prefix.length) {
        const frame = pending.shift();
        if (!frame) {
          await new Promise<void>((resolve) => {
            notifyFrame = resolve;
          });
          continue;
        }
        forwardedText += frame.text;
        frame.forward();
      }
      if (forwardedText !== prefix) {
        throw new Error(
          `Stream did not stop at ${JSON.stringify(prefix)}: ${JSON.stringify(forwardedText)}`,
        );
      }
    },
    release() {
      released = true;
      for (const frame of pending.splice(0)) frame.forward();
    },
  };
}
