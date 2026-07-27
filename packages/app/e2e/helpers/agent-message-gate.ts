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
  let browserSocket: WebSocketRoute | null = null;
  const heldMessages: Array<WebSocketMessage | null> = [];
  const requests: SendAgentMessageRequest[] = [];
  const requestWaiters = new Set<() => void>();

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    browserSocket = ws;
    const server = ws.connectToServer();
    serverSocket = server;

    ws.onMessage((message) => {
      const request = readSendRequest(message);
      if (request) {
        heldMessages.push(message);
        requests.push(request);
        for (const resolve of requestWaiters) resolve();
        requestWaiters.clear();
        return;
      }
      server.send(message);
    });

    server.onMessage((message) => ws.send(message));
  });

  const waitForRequest = async (count = 1): Promise<SendAgentMessageRequest> => {
    while (requests.length < count) {
      await new Promise<void>((resolve) => requestWaiters.add(resolve));
    }
    return requests[count - 1];
  };

  return {
    waitForRequest,
    accept(index = 0) {
      const heldMessage = heldMessages[index];
      if (!serverSocket || !heldMessage) {
        throw new Error("No held send-agent-message request to accept");
      }
      serverSocket.send(heldMessage);
      heldMessages[index] = null;
    },
    async disconnect(): Promise<void> {
      if (!browserSocket) throw new Error("No browser daemon socket to disconnect");
      await browserSocket.close({ code: 1008, reason: "Dropped by submission test." });
    },
  };
}
