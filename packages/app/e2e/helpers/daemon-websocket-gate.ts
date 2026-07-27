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
  subscribe?: unknown;
  page?: { cursor?: unknown };
  payload?: unknown;
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

export async function installDaemonWebSocketGate(page: Page) {
  let acceptingConnections = true;
  let reconnectWithFreshClient = false;
  let suppressAgentStream = false;
  let forceTimelineEpochReset = false;
  let heldClientRequestType: string | null = null;
  let heldClientRequest: { server: WebSocketRoute; message: string | Buffer } | null = null;
  let resolveHeldClientRequest: (() => void) | null = null;
  const activeSockets = new Set<WebSocketRoute>();
  const directoryStarts: DirectoryRequestStartCounts = {
    subscribed: { agents: 0, workspaces: 0 },
    unsubscribed: { agents: 0, workspaces: 0 },
    total: { agents: 0, workspaces: 0 },
  };
  const clientRequestCounts = new Map<string, number>();
  const serverMessageCounts = new Map<string, number>();
  const serverMessageWaiters = new Set<() => void>();

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    if (!acceptingConnections) {
      void ws.close({ code: 1008, reason: "Blocked by reconnect test." });
      return;
    }

    activeSockets.add(ws);
    const server = ws.connectToServer();

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
      let outboundMessage = message;
      if (
        forceTimelineEpochReset &&
        serverMessage?.type === "fetch_agent_timeline_response" &&
        typeof message === "string"
      ) {
        const envelope = JSON.parse(message) as {
          message?: { payload?: Record<string, unknown> };
          payload?: Record<string, unknown>;
        };
        const payload = envelope.message?.payload ?? envelope.payload;
        if (payload) {
          payload.epoch = `playwright-reset-${Date.now()}`;
          payload.reset = true;
          outboundMessage = JSON.stringify(envelope);
          forceTimelineEpochReset = false;
        }
      }
      if (typeof serverMessage?.type === "string") {
        serverMessageCounts.set(
          serverMessage.type,
          (serverMessageCounts.get(serverMessage.type) ?? 0) + 1,
        );
        for (const resolve of serverMessageWaiters) resolve();
        serverMessageWaiters.clear();
      }
      if (suppressAgentStream && serverMessage?.type === "agent_stream") return;
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
    async waitForServerMessage(type: string, count = 1): Promise<void> {
      while ((serverMessageCounts.get(type) ?? 0) < count) {
        await new Promise<void>((resolve) => serverMessageWaiters.add(resolve));
      }
    },
  };
}
