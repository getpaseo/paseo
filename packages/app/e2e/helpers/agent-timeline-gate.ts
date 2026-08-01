import type { Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

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
  getRepeatedAssistantEntryCount(): number;
  releasePage(pageNumber: number): void;
  waitForRequestCount(count: number): Promise<void>;
}

export interface DaemonHydrationGate {
  release(): void;
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

export async function delayCreatedAgentInitialTailResponse(
  page: Page,
): Promise<CreatedAgentTimelineGate> {
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
      const sessionMessage = getSessionMessage(message);
      const payload = sessionMessage ? getPayload(sessionMessage) : null;
      if (sessionMessage?.type === "status" && payload?.status === "agent_created") {
        const agentId = payload.agentId;
        if (typeof agentId === "string") {
          createdAgentId = agentId;
          resolveCreatedAgent?.(agentId);
        }
      }

      if (sessionMessage?.type === "fetch_agent_timeline_response") {
        const agentId = payload?.agentId;
        const direction = payload?.direction;
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
): Promise<OlderTimelinePagesGate> {
  let requestCount = 0;
  let responseCount = 0;
  let repeatedAssistantEntryCount = 0;
  const assistantEntryKeys = new Set<string>();
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

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
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
        payload.direction === "before"
      ) {
        responseCount += 1;
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        for (const entry of entries) {
          if (!entry || typeof entry !== "object") continue;
          const projectedEntry = entry as {
            seqStart?: unknown;
            seqEnd?: unknown;
            item?: { type?: unknown };
          };
          if (
            typeof projectedEntry.seqStart !== "number" ||
            typeof projectedEntry.seqEnd !== "number" ||
            typeof projectedEntry.item?.type !== "string"
          ) {
            continue;
          }
          if (projectedEntry.item.type !== "assistant_message") continue;
          const key = `${projectedEntry.seqStart}:${projectedEntry.seqEnd}:${projectedEntry.item.type}`;
          if (assistantEntryKeys.has(key)) repeatedAssistantEntryCount += 1;
          else assistantEntryKeys.add(key);
        }
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
    getRepeatedAssistantEntryCount: () => repeatedAssistantEntryCount,
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
