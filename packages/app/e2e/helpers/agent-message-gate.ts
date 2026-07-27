import type { Page, WebSocketRoute } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";

type WebSocketMessage = string | Buffer;

interface SendAgentMessageRequest {
  type: "send_agent_message_request";
  requestId: string;
  agentId: string;
}

function readSendRequest(message: WebSocketMessage): SendAgentMessageRequest | null {
  if (typeof message !== "string") return null;
  try {
    const envelope = JSON.parse(message) as {
      type?: unknown;
      message?: Record<string, unknown>;
    };
    const request = envelope.type === "session" ? envelope.message : null;
    if (
      request?.type !== "send_agent_message_request" ||
      typeof request.requestId !== "string" ||
      typeof request.agentId !== "string"
    ) {
      return null;
    }
    return {
      type: "send_agent_message_request",
      requestId: request.requestId,
      agentId: request.agentId,
    };
  } catch {
    return null;
  }
}

export async function gateNextAgentMessage(page: Page) {
  let serverSocket: WebSocketRoute | null = null;
  let heldMessage: WebSocketMessage | null = null;
  let hasHeldRequest = false;
  let resolveRequest: ((request: SendAgentMessageRequest) => void) | null = null;
  const requestSeen = new Promise<SendAgentMessageRequest>((resolve) => {
    resolveRequest = resolve;
  });

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    const server = ws.connectToServer();
    serverSocket = server;

    ws.onMessage((message) => {
      const request = readSendRequest(message);
      if (request && !hasHeldRequest) {
        heldMessage = message;
        hasHeldRequest = true;
        resolveRequest?.(request);
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => ws.send(message));
  });

  return {
    waitForRequest: () => requestSeen,
    accept() {
      if (!serverSocket || !heldMessage) {
        throw new Error("No held send-agent-message request to accept");
      }
      serverSocket.send(heldMessage);
      heldMessage = null;
    },
  };
}
