import express from "express";
import { createServer as createHTTPServer, type Server as HttpServer } from "node:http";
import { formatHostForHttpUrl, type ListenTarget } from "./listeners.js";

interface LoopbackTcpTarget {
  type: "tcp";
  host: string;
  port: number;
}

const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST_HEADERS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  return remoteAddress !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(remoteAddress);
}

function parseHostHeaderHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const trimmed = hostHeader.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end === -1) return null;
    return trimmed.slice(1, end).toLowerCase();
  }

  const colonIndex = trimmed.indexOf(":");
  return (colonIndex === -1 ? trimmed : trimmed.slice(0, colonIndex)).toLowerCase();
}

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  const hostname = parseHostHeaderHostname(hostHeader);
  return hostname !== null && LOOPBACK_HOST_HEADERS.has(hostname);
}

/**
 * Resolves a loopback-reachable TCP target from the daemon's primary listener when
 * the primary listener already accepts local loopback connections. Returns `null`
 * for Unix sockets, Windows named pipes, and non-loopback TCP interfaces so the
 * daemon binds a dedicated internal `127.0.0.1:0` endpoint for local agents instead.
 */
export function resolvePrimaryLoopbackTarget(
  listenTarget: ListenTarget | null,
): LoopbackTcpTarget | null {
  if (!listenTarget || listenTarget.type !== "tcp") {
    return null;
  }

  const normalizedHost = listenTarget.host.trim().toLowerCase();
  if (normalizedHost === "0.0.0.0") {
    return { type: "tcp", host: "127.0.0.1", port: listenTarget.port };
  }
  if (normalizedHost === "::" || normalizedHost === "[::]") {
    return { type: "tcp", host: "::1", port: listenTarget.port };
  }
  if (normalizedHost === "127.0.0.1" || normalizedHost === "localhost") {
    return { type: "tcp", host: normalizedHost, port: listenTarget.port };
  }
  if (normalizedHost === "::1" || normalizedHost === "[::1]") {
    return { type: "tcp", host: "::1", port: listenTarget.port };
  }
  return null;
}

export function createAgentMcpBaseUrl(listenTarget: ListenTarget | null): string | null {
  const loopbackTarget = resolvePrimaryLoopbackTarget(listenTarget);
  if (!loopbackTarget) {
    return null;
  }
  return new URL(
    "/mcp/agents",
    `http://${formatHostForHttpUrl(loopbackTarget.host)}:${loopbackTarget.port}`,
  ).toString();
}

export function createTerminalActivityUrl(listenTarget: ListenTarget | null): string | null {
  const loopbackTarget = resolvePrimaryLoopbackTarget(listenTarget);
  if (!loopbackTarget) {
    return null;
  }
  return new URL(
    "/api/terminal-activity",
    `http://${formatHostForHttpUrl(loopbackTarget.host)}:${loopbackTarget.port}`,
  ).toString();
}

interface LoopbackAgentEndpointOptions {
  handleAgentMcpRequest: express.RequestHandler;
  handleTerminalActivityRequest: express.RequestHandler;
}

interface StartedLoopbackAgentEndpoint {
  target: LoopbackTcpTarget;
  dedicated: boolean;
}

export interface LoopbackAgentEndpoint {
  start(primaryListenTarget: ListenTarget): Promise<StartedLoopbackAgentEndpoint>;
  stop(): Promise<void>;
  getTarget(): LoopbackTcpTarget | null;
  getMcpBaseUrl(): string | null;
  getTerminalActivityUrl(): string | null;
}

export function createLoopbackAgentEndpoint(
  options: LoopbackAgentEndpointOptions,
): LoopbackAgentEndpoint {
  let target: LoopbackTcpTarget | null = null;
  let internalServer: HttpServer | null = null;

  const stop = async (): Promise<void> => {
    target = null;
    const serverToClose = internalServer;
    internalServer = null;
    if (!serverToClose) {
      return;
    }
    serverToClose.closeAllConnections();
    await new Promise<void>((resolve) => {
      serverToClose.close(() => resolve());
    });
  };

  const start = async (
    primaryListenTarget: ListenTarget,
  ): Promise<StartedLoopbackAgentEndpoint> => {
    await stop();

    const reused = resolvePrimaryLoopbackTarget(primaryListenTarget);
    if (reused) {
      target = reused;
      return { target: reused, dedicated: false };
    }

    const internalApp = express();
    internalApp.use((req, res, next) => {
      if (!isLoopbackRemoteAddress(req.socket.remoteAddress)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host : undefined;
      if (!isLoopbackHostHeader(hostHeader)) {
        res.status(403).json({ error: "Invalid Host header" });
        return;
      }
      next();
    });
    internalApp.use(express.json());

    internalApp.post("/mcp/agents", options.handleAgentMcpRequest);
    internalApp.get("/mcp/agents", options.handleAgentMcpRequest);
    internalApp.delete("/mcp/agents", options.handleAgentMcpRequest);
    internalApp.post("/api/terminal-activity", options.handleTerminalActivityRequest);

    const server = createHTTPServer(internalApp);
    const boundPort = await new Promise<number>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.off("error", onError);
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Internal loopback agent HTTP server did not expose a TCP port"));
          return;
        }
        resolve(address.port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });

    internalServer = server;
    target = { type: "tcp", host: "127.0.0.1", port: boundPort };
    return { target, dedicated: true };
  };

  return {
    start,
    stop,
    getTarget: () => target,
    getMcpBaseUrl: () => createAgentMcpBaseUrl(target),
    getTerminalActivityUrl: () => createTerminalActivityUrl(target),
  };
}
