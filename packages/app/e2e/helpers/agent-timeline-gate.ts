import type { Page } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface CreatedAgentTimelineGate {
  release(): void;
  waitForCreatedAgent(): Promise<string>;
  waitForDelayedResponse(): Promise<void>;
  waitForForwardedResponse(): Promise<void>;
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
