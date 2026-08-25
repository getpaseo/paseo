import { WebSocket, type RawData } from "ws";

/**
 * The daemon's seam onto a Chrome DevTools Protocol endpoint someone else runs:
 * headless Chrome with `--remote-debugging-port`, Lightpanda, Browserless, or a
 * hosted browser. Everything above this interface is protocol translation, so
 * tests drive the headless host through an in-memory connection instead of a
 * real browser.
 */
export interface CdpConnection {
  /** Resolves with the command result, or rejects with {@link CdpCommandError}. */
  send(command: CdpCommand): Promise<CdpResult>;
  onEvent(listener: (event: CdpEvent) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface CdpCommand {
  method: string;
  params?: Record<string, unknown>;
  /** Set for a command aimed at one attached target rather than the browser. */
  sessionId?: string;
}

export type CdpResult = Record<string, unknown>;

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId: string | undefined;
}

/** Opens a connection to `endpoint`; rejects with {@link CdpConnectError}. */
export type CdpConnector = (endpoint: string) => Promise<CdpConnection>;

export class CdpConnectError extends Error {
  public readonly endpoint: string;

  public constructor(endpoint: string, cause: string) {
    super(`Cannot reach the browser CDP endpoint ${endpoint}: ${cause}`);
    this.name = "CdpConnectError";
    this.endpoint = endpoint;
  }
}

export class CdpCommandError extends Error {
  public readonly method: string;
  public readonly code: number;

  public constructor(method: string, code: number, message: string) {
    super(`${method} failed: ${message}`);
    this.name = "CdpCommandError";
    this.method = method;
    this.code = code;
  }
}

/** The socket went away with commands still outstanding. */
export class CdpConnectionClosedError extends Error {
  public constructor(method: string) {
    super(`${method} failed: the browser CDP connection closed`);
    this.name = "CdpConnectionClosedError";
  }
}

interface PendingCdpCommand {
  method: string;
  resolve: (result: CdpResult) => void;
  reject: (error: Error) => void;
}

const HTTP_ENDPOINT_PROTOCOLS = new Set(["http:", "https:"]);

/**
 * Chrome mints a fresh browser-level WebSocket path on every launch, so an
 * `http://host:9222` endpoint has to be resolved through `/json/version` first.
 * Engines that publish a stable socket, such as Lightpanda, are given as `ws://`
 * and connected to directly.
 */
export async function connectCdpWebSocket(endpoint: string): Promise<CdpConnection> {
  const socketUrl = await resolveCdpWebSocketUrl(endpoint);
  const socket = new WebSocket(socketUrl, { maxPayload: 0 });
  await waitForOpenSocket(socket, endpoint);
  return new WebSocketCdpConnection(socket);
}

async function resolveCdpWebSocketUrl(endpoint: string): Promise<string> {
  const url = parseEndpoint(endpoint);
  if (!HTTP_ENDPOINT_PROTOCOLS.has(url.protocol)) {
    return endpoint;
  }
  const response = await fetch(new URL("/json/version", url)).catch((error: unknown) => {
    throw new CdpConnectError(endpoint, describeCause(error));
  });
  if (!response.ok) {
    // Chrome answers /json only when the Host header is a hostname; given an IP
    // it returns 404, which reads like the endpoint is wrong rather than picky.
    const hint =
      response.status === 404 && isIpHostname(url.hostname)
        ? ". Chrome serves this only to a hostname, so use localhost rather than an IP"
        : "";
    throw new CdpConnectError(endpoint, `/json/version returned HTTP ${response.status}${hint}`);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || typeof body.webSocketDebuggerUrl !== "string") {
    throw new CdpConnectError(endpoint, "/json/version has no webSocketDebuggerUrl");
  }
  return body.webSocketDebuggerUrl;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isIpHostname(hostname: string): boolean {
  return /^\[?[0-9a-fA-F:.]+\]?$/.test(hostname) && hostname !== "localhost";
}

/**
 * Whether the browser behind this endpoint runs on the daemon's own machine,
 * which is what decides if a viewer's new tab belongs to it and whether the page
 * can reach the daemon's localhost services.
 */
export function isLoopbackCdpEndpoint(endpoint: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function parseEndpoint(endpoint: string): URL {
  try {
    return new URL(endpoint);
  } catch {
    throw new CdpConnectError(endpoint, "it is not a valid URL");
  }
}

function waitForOpenSocket(socket: WebSocket, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.removeAllListeners("error");
      resolve();
    });
    socket.once("error", (error: Error) => {
      socket.close();
      reject(new CdpConnectError(endpoint, describeCause(error)));
    });
  });
}

class WebSocketCdpConnection implements CdpConnection {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, PendingCdpCommand>();
  private readonly eventListeners = new Set<(event: CdpEvent) => void>();
  private readonly closeListeners = new Set<() => void>();
  private nextCommandId = 0;

  public constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data: RawData) => {
      this.receive(data.toString());
    });
    // `error` on an open socket is always followed by `close`, so teardown is
    // driven from one place and a transport failure cannot leave the host
    // registered against a browser it can no longer reach.
    socket.on("error", () => {});
    socket.on("close", () => {
      this.handleClose();
    });
  }

  public send(command: CdpCommand): Promise<CdpResult> {
    if (this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CdpConnectionClosedError(command.method));
    }
    const id = ++this.nextCommandId;
    return new Promise<CdpResult>((resolve, reject) => {
      this.pending.set(id, { method: command.method, resolve, reject });
      this.socket.send(
        JSON.stringify({
          id,
          method: command.method,
          params: command.params ?? {},
          ...(command.sessionId ? { sessionId: command.sessionId } : {}),
        }),
      );
    });
  }

  public onEvent(listener: (event: CdpEvent) => void): void {
    this.eventListeners.add(listener);
  }

  public onClose(listener: () => void): void {
    this.closeListeners.add(listener);
  }

  public close(): void {
    this.socket.close();
  }

  private receive(raw: string): void {
    const message = parseJson(raw);
    if (!isRecord(message)) {
      return;
    }
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (typeof message.method === "string") {
      const params = isRecord(message.params) ? message.params : {};
      for (const listener of this.eventListeners) {
        listener({ method: message.method, params, sessionId });
      }
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      const code = typeof message.error.code === "number" ? message.error.code : 0;
      const text =
        typeof message.error.message === "string" ? message.error.message : "unknown CDP error";
      pending.reject(new CdpCommandError(pending.method, code, text));
      return;
    }
    pending.resolve(isRecord(message.result) ? message.result : {});
  }

  private handleClose(): void {
    for (const pending of this.pending.values()) {
      pending.reject(new CdpConnectionClosedError(pending.method));
    }
    this.pending.clear();
    for (const listener of this.closeListeners) {
      listener();
    }
    this.closeListeners.clear();
    this.eventListeners.clear();
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function describeCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
