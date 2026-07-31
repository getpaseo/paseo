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
  mode?: unknown;
  path?: unknown;
}

interface ServerMessage {
  type?: unknown;
  payload?: {
    kind?: unknown;
    agent?: {
      id?: unknown;
      status?: unknown;
    };
    initial?: {
      path?: unknown;
    };
    version?: {
      status?: unknown;
      path?: unknown;
    };
  };
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

function readServerMessage(message: string | Buffer): ServerMessage | null {
  try {
    const envelope = JSON.parse(typeof message === "string" ? message : message.toString()) as {
      type?: unknown;
      message?: ServerMessage;
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

function isStoppedAgentUpdate(message: ServerMessage | null, agentId: string | null): boolean {
  return (
    message?.type === "agent_update" &&
    message.payload?.kind === "upsert" &&
    message.payload.agent?.id === agentId &&
    message.payload.agent.status !== "running"
  );
}

export async function installDaemonWebSocketGate(page: Page) {
  let acceptingConnections = true;
  const activeSockets = new Set<WebSocketRoute>();
  const directoryStarts: DirectoryRequestStartCounts = {
    subscribed: { agents: 0, workspaces: 0 },
    unsubscribed: { agents: 0, workspaces: 0 },
    total: { agents: 0, workspaces: 0 },
  };
  const clientRequestCounts = new Map<string, number>();
  const subscribedFilePaths = new Set<string>();
  const fileSubscriptionWaiters = new Map<string, () => void>();
  let fileReadPathToHold: string | null = null;
  let heldFileReads: Array<() => void> = [];
  let resolveHeldFileRead: (() => void) | null = null;
  let heldFileReadPromise = Promise.resolve();
  let readyFileUpdatePathToHold: string | null = null;
  let heldReadyFileUpdate: (() => void) | null = null;
  let resolveHeldReadyFileUpdate: (() => void) | null = null;
  let heldReadyFileUpdatePromise = Promise.resolve();
  let stoppedAgentUpdateIdToHold: string | null = null;
  let heldStoppedAgentUpdate: (() => void) | null = null;
  let resolveHeldStoppedAgentUpdate: (() => void) | null = null;
  let heldStoppedAgentUpdatePromise = Promise.resolve();

  const recordFileSubscription = (message: ServerMessage | null): void => {
    if (
      message?.type !== "fs.file.subscribe.response" ||
      typeof message.payload?.initial?.path !== "string"
    ) {
      return;
    }
    const path = message.payload.initial.path;
    subscribedFilePaths.add(path);
    fileSubscriptionWaiters.get(path)?.();
    fileSubscriptionWaiters.delete(path);
  };

  await page.routeWebSocket(daemonWsRoutePattern(), (ws) => {
    if (!acceptingConnections) {
      void ws.close({ code: 1008, reason: "Blocked by reconnect test." });
      return;
    }

    activeSockets.add(ws);
    const server = ws.connectToServer();

    ws.onMessage((message) => {
      if (!acceptingConnections) return;
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
      const serverMessage = readServerMessage(message);
      if (
        isStoppedAgentUpdate(serverMessage, stoppedAgentUpdateIdToHold) &&
        !heldStoppedAgentUpdate
      ) {
        heldStoppedAgentUpdate = () => ws.send(message);
        resolveHeldStoppedAgentUpdate?.();
        return;
      }
      recordFileSubscription(serverMessage);
      if (
        serverMessage?.type === "fs.file.update" &&
        serverMessage.payload?.version?.status === "ready" &&
        serverMessage.payload.version.path === readyFileUpdatePathToHold &&
        !heldReadyFileUpdate
      ) {
        heldReadyFileUpdate = () => ws.send(message);
        resolveHeldReadyFileUpdate?.();
        return;
      }
      try {
        ws.send(message);
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
    holdNextStoppedAgentUpdate(agentId: string): void {
      stoppedAgentUpdateIdToHold = agentId;
      heldStoppedAgentUpdate = null;
      heldStoppedAgentUpdatePromise = new Promise((resolve) => {
        resolveHeldStoppedAgentUpdate = resolve;
      });
    },
    waitForHeldStoppedAgentUpdate(): Promise<void> {
      return heldStoppedAgentUpdatePromise;
    },
    releaseHeldStoppedAgentUpdate(): void {
      const forward = heldStoppedAgentUpdate;
      heldStoppedAgentUpdate = null;
      stoppedAgentUpdateIdToHold = null;
      resolveHeldStoppedAgentUpdate = null;
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
  };
}
