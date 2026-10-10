import { randomBytes, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Duplex } from "node:stream";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/tunnel";

// The warm-up target never leaves the proxy: main requests it through the routed
// session right after setProxy so Chromium caches the proxy credential before a
// WebSocket can be the first connection (a cold WebSocket gets 407 without `login`).
export const BROWSER_PROXY_WARMUP_HOST = "paseo-proxy-warmup.invalid";
export const BROWSER_PROXY_LOOPBACK_HOST = "127.0.0.1";
export const PROXY_AUTH_REALM = "Paseo";
const MAX_PENDING_SOCKET_WRITE_BYTES = 256 * 1024;

export interface ProxyCredential {
  readonly username: string;
  readonly password: string;
}

export interface ProxyTarget {
  readonly host: string;
  readonly port: number;
}

/**
 * Receives what the tunnel delivers for one stream. `consumed` must be called once
 * the bytes reached their final destination; it is the only thing that returns
 * credit to the daemon.
 */
export interface TunnelStreamSink {
  onConnected(): void;
  onData(data: Uint8Array, consumed: () => void): void;
  onClose(reason: number): void;
}

/** Proxy-side handle for one tunnel stream. Writes resolve once the bytes left main. */
export interface TunnelStreamHandle {
  write(data: Uint8Array, callback: (error?: Error | null) => void): void;
  close(reason?: number): void;
}

export type OpenTunnelStream = (
  target: ProxyTarget,
  sink: TunnelStreamSink,
) => TunnelStreamHandle | null;

export interface LocalBrowserProxy {
  readonly port: number;
  readonly credential: ProxyCredential;
  close(): Promise<void>;
}

/** Observation port for tests: when response bytes are handed to and accepted by the local socket. */
export interface LocalProxyDiagnostics {
  localWriteIssued?(bytes: number): void;
  localWriteCompleted?(bytes: number): void;
}

export interface LocalBrowserProxyOptions {
  openStream: OpenTunnelStream;
  credential?: ProxyCredential;
  log?: (event: string, details: Record<string, unknown>) => void;
  diagnostics?: LocalProxyDiagnostics;
}

export class TunnelStreamError extends Error {
  public constructor(public readonly reason: number) {
    super(`tunnel stream closed (reason ${reason})`);
    this.name = "TunnelStreamError";
  }
}

export function createProxyCredential(): ProxyCredential {
  return {
    username: `paseo-${randomBytes(9).toString("base64url")}`,
    password: randomBytes(24).toString("base64url"),
  };
}

export function httpStatusForTunnelCloseReason(reason: number): number {
  switch (reason) {
    case TunnelCloseReason.PolicyDenied:
      return 403;
    case TunnelCloseReason.Timeout:
      return 504;
    case TunnelCloseReason.StreamLimit:
      return 503;
    default:
      return 502;
  }
}

export async function startLocalBrowserProxy(
  options: LocalBrowserProxyOptions,
): Promise<LocalBrowserProxy> {
  const credential = options.credential ?? createProxyCredential();
  const log = options.log ?? (() => {});
  const expectedAuthorization = Buffer.from(
    `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString("base64")}`,
  );
  const sockets = new Set<Socket>();

  const isAuthorized = (req: IncomingMessage): boolean => {
    const header = req.headers["proxy-authorization"];
    if (typeof header !== "string") {
      return false;
    }
    const provided = Buffer.from(header);
    return (
      provided.length === expectedAuthorization.length &&
      timingSafeEqual(provided, expectedAuthorization)
    );
  };

  // Every response carries Connection: close, but a client may still pipeline a
  // second request before the first answer. Only the first request a connection
  // ever carries reaches the tunnel; anything after it is answered 400 (queued
  // behind the first response, which already closes the socket) and never forwarded.
  const servedSockets = new WeakSet<Socket>();
  const claimSocket = (socket: Socket): boolean => {
    if (servedSockets.has(socket)) {
      return false;
    }
    servedSockets.add(socket);
    return true;
  };

  const server = http.createServer((req, res) => {
    if (!claimSocket(req.socket)) {
      const target = parseAbsoluteHttpTarget(req.url);
      log("http.extra-request-refused", { host: target?.host ?? null, port: target?.port ?? null });
      req.resume();
      sendProxyError(res, 400, "Bad Request", "One request per connection.");
      return;
    }
    handleHttpRequest({
      req,
      res,
      isAuthorized,
      openStream: options.openStream,
      log,
      diagnostics: options.diagnostics,
    });
  });
  server.on("connect", (req, socket, head) => {
    if (!claimSocket(socket as Socket)) {
      socket.destroy();
      return;
    }
    handleConnect({
      req,
      socket: socket as Socket,
      head,
      isAuthorized,
      openStream: options.openStream,
      log,
    });
  });
  // Chromium tunnels ws:// through CONNECT; an Upgrade on a plain proxy request is
  // never ours to forward.
  server.on("upgrade", (_req, socket) => {
    writeRawResponse(socket as Socket, 501, "Not Implemented");
  });
  server.on("clientError", (error: NodeJS.ErrnoException, socket) => {
    if (error.code === "ECONNRESET" || !socket.writable) {
      socket.destroy();
      return;
    }
    const status = error.code === "HPE_HEADER_OVERFLOW" ? 431 : 400;
    writeRawResponse(
      socket as Socket,
      status,
      status === 431 ? "Request Header Fields Too Large" : "Bad Request",
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, BROWSER_PROXY_LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;

  return {
    port,
    credential,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) {
          socket.destroy();
        }
      }),
  };
}

interface RequestContext {
  isAuthorized(req: IncomingMessage): boolean;
  openStream: OpenTunnelStream;
  log: (event: string, details: Record<string, unknown>) => void;
  diagnostics?: LocalProxyDiagnostics;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function connectionTokens(headers: IncomingMessage["headers"]): Set<string> {
  const tokens = new Set<string>();
  for (const value of [headers.connection, headers["proxy-connection"]]) {
    if (typeof value !== "string") continue;
    for (const token of value.split(",")) {
      const normalized = token.trim().toLowerCase();
      if (normalized) tokens.add(normalized);
    }
  }
  return tokens;
}

function stripHopByHopHeaders(message: IncomingMessage): string[] {
  const dropped = connectionTokens(message.headers);
  const kept: string[] = [];
  for (let index = 0; index + 1 < message.rawHeaders.length; index += 2) {
    const name = message.rawHeaders[index];
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || dropped.has(lower)) continue;
    kept.push(name, message.rawHeaders[index + 1]);
  }
  return kept;
}

function parseAbsoluteHttpTarget(
  rawUrl: string | undefined,
): (ProxyTarget & { path: string }) | null {
  if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !url.hostname) {
    return null;
  }
  const port = url.port ? Number(url.port) : 80;
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
    port,
    path: `${url.pathname}${url.search}`,
  };
}

function parseConnectTarget(rawUrl: string | undefined): ProxyTarget | null {
  if (!rawUrl) return null;
  const match = /^(?:\[([^\]]+)\]|([^:[\]]+)):(\d{1,5})$/.exec(rawUrl);
  if (!match) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: match[1] ?? match[2], port };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function errorPage(status: number, title: string, detail: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${status} ${escapeHtml(title)}</title></head><body><h1>${status} ${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></body></html>`;
}

function sendProxyError(res: ServerResponse, status: number, title: string, detail: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = errorPage(status, title, detail);
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    Connection: "close",
    ...(status === 407 ? { "Proxy-Authenticate": `Basic realm="${PROXY_AUTH_REALM}"` } : {}),
  });
  res.end(body);
}

function writeRawResponse(socket: Socket, status: number, title: string): void {
  if (socket.destroyed) return;
  const extra = status === 407 ? `Proxy-Authenticate: Basic realm="${PROXY_AUTH_REALM}"\r\n` : "";
  socket.end(
    `HTTP/1.1 ${status} ${title}\r\n${extra}Connection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function titleForStatus(status: number): string {
  switch (status) {
    case 403:
      return "Forbidden";
    case 503:
      return "Service Unavailable";
    case 504:
      return "Gateway Timeout";
    default:
      return "Bad Gateway";
  }
}

function detailForReason(target: ProxyTarget, reason: number): string {
  const where = `${target.host}:${target.port}`;
  switch (reason) {
    case TunnelCloseReason.PolicyDenied:
      return `The host denied a connection to ${where}.`;
    case TunnelCloseReason.HostNotFound:
      return `The host could not resolve ${target.host}.`;
    case TunnelCloseReason.ConnectionRefused:
      return `${where} refused the connection on the host.`;
    case TunnelCloseReason.Timeout:
      return `Connecting to ${where} from the host timed out.`;
    case TunnelCloseReason.StreamLimit:
      return "Too many simultaneous connections through the host.";
    default:
      return `The host could not reach ${where}.`;
  }
}

interface InflightChunk {
  consumed: () => void;
  pendingWrites: number;
  parsed: boolean;
}

/**
 * Bridges the tunnel stream into a Duplex that node:http can treat as the upstream
 * socket. Inbound chunks reach the parser one at a time: the next chunk is handed
 * over only after every local write the previous one produced has completed, and
 * that is also when its credit returns to the daemon. Credit therefore never
 * precedes the last write of its chunk, and the sum of credit equals the bytes
 * delivered.
 */
export class TunnelDuplex extends Duplex {
  private handle: TunnelStreamHandle | null = null;
  private readonly inbound: Array<{ data: Uint8Array; consumed: () => void }> = [];
  private inflight: InflightChunk | null = null;
  private wantsData = false;
  private inboundEnded = false;
  private closedByTunnel = false;

  public constructor(private readonly diagnostics: LocalProxyDiagnostics | undefined) {
    super({ readableHighWaterMark: 16 * 1024, allowHalfOpen: false });
  }

  public attach(handle: TunnelStreamHandle): void {
    this.handle = handle;
  }

  /**
   * Registers a local write produced by the chunk being parsed. The returned
   * function must be called from that write's callback (once).
   */
  public trackLocalWrite(bytes: number): () => void {
    const chunk = this.inflight;
    this.diagnostics?.localWriteIssued?.(bytes);
    let completed = false;
    if (chunk) chunk.pendingWrites += 1;
    return () => {
      if (completed) return;
      completed = true;
      this.diagnostics?.localWriteCompleted?.(bytes);
      if (chunk) {
        chunk.pendingWrites -= 1;
        this.settle(chunk);
      }
    };
  }

  public readonly sink: TunnelStreamSink = {
    onConnected: () => this.emit("tunnel-connected"),
    onData: (data, consumed) => {
      this.inbound.push({ data, consumed });
      this.drainInbound();
    },
    onClose: (reason) => {
      this.closedByTunnel = true;
      if (reason === TunnelCloseReason.Ok) {
        // Data received before a normal close is delivered in order before EOF.
        this.inboundEnded = true;
        this.drainInbound();
        return;
      }
      this.destroy(new TunnelStreamError(reason));
    },
  };

  public override _read(): void {
    this.wantsData = true;
    this.drainInbound();
  }

  public override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    if (!this.handle) {
      callback(new Error("tunnel stream not attached"));
      return;
    }
    this.handle.write(chunk, callback);
  }

  public override _final(callback: (error?: Error | null) => void): void {
    callback();
  }

  public override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.closedByTunnel) {
      this.handle?.close(error ? TunnelCloseReason.GeneralError : TunnelCloseReason.Ok);
    }
    callback(error);
  }

  private settle(chunk: InflightChunk): void {
    if (!chunk.parsed || chunk.pendingWrites > 0 || this.inflight !== chunk) {
      return;
    }
    this.inflight = null;
    chunk.consumed();
    this.drainInbound();
  }

  private drainInbound(): void {
    if (!this.inflight && this.wantsData && this.inbound.length > 0) {
      const next = this.inbound.shift()!;
      const chunk: InflightChunk = { consumed: next.consumed, pendingWrites: 0, parsed: false };
      this.inflight = chunk;
      this.wantsData = this.push(
        Buffer.from(next.data.buffer, next.data.byteOffset, next.data.byteLength),
      );
      // Everything the parser emits for this chunk runs before this fires: the
      // synchronous events now and the response "end" on nextTick.
      setImmediate(() => {
        chunk.parsed = true;
        this.settle(chunk);
      });
    }
    if (this.inboundEnded && this.inbound.length === 0 && !this.inflight) {
      this.inboundEnded = false;
      this.push(null);
    }
  }
}

function handleHttpRequest(
  input: {
    req: IncomingMessage;
    res: ServerResponse;
  } & RequestContext,
): void {
  const { req, res, isAuthorized, openStream, log } = input;
  if (!isAuthorized(req)) {
    sendProxyError(res, 407, "Proxy Authentication Required", "This proxy is private to Paseo.");
    return;
  }
  const target = parseAbsoluteHttpTarget(req.url);
  if (!target) {
    sendProxyError(res, 400, "Bad Request", "Only absolute http:// requests are accepted.");
    return;
  }
  if (target.host === BROWSER_PROXY_WARMUP_HOST) {
    res.writeHead(204, { Connection: "close", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const duplex = new TunnelDuplex(input.diagnostics);
  const handle = openStream({ host: target.host, port: target.port }, duplex.sink);
  if (!handle) {
    sendProxyError(
      res,
      503,
      "Service Unavailable",
      "The host is not connected to this browser profile.",
    );
    return;
  }
  duplex.attach(handle);

  const upstream = http.request({
    createConnection: () => duplex,
    method: req.method,
    path: target.path,
    headers: toHeaderRecord(stripHopByHopHeaders(req)),
    setHost: false,
  });
  upstream.on("information", (info) => {
    // Only 103 with a Link header is relayed; node:http writes nothing for the other
    // cases, so the chunk's credit returns once its parse pass finishes.
    const link = info.headers.link;
    if (info.statusCode !== 103 || !link || link.length === 0) {
      return;
    }
    const hints = info.headers as Record<string, string | string[]>;
    const head = `HTTP/1.1 103 Early Hints\r\n${Object.entries(hints)
      .map(([name, value]) => `${name}: ${String(value)}\r\n`)
      .join("")}\r\n`;
    const completed = duplex.trackLocalWrite(Buffer.byteLength(head));
    try {
      res.writeEarlyHints(hints, completed);
    } catch (error) {
      // Node validates the Link header strictly; an upstream hint it rejects is
      // dropped rather than aborting the request, and nothing was written.
      completed();
      log("http.early-hints-dropped", { host: target.host, error: String(error) });
    }
  });
  upstream.on("response", (upstreamRes) => {
    const headers = stripHopByHopHeaders(upstreamRes);
    headers.push("Connection", "close");
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage || undefined, headers);
    // Manual pump instead of pipe: every local write is attributed to the tunnel
    // chunk being parsed, and that chunk's credit waits for all of them. The next
    // chunk is not parsed until then, which is also the backpressure.
    upstreamRes.on("data", (body: Buffer) => {
      res.write(body, duplex.trackLocalWrite(body.length));
    });
    upstreamRes.on("end", () => {
      res.end(duplex.trackLocalWrite(0));
    });
    upstreamRes.on("error", () => res.destroy());
  });
  upstream.on("error", (error) => {
    const reason =
      error instanceof TunnelStreamError ? error.reason : TunnelCloseReason.GeneralError;
    const status = httpStatusForTunnelCloseReason(reason);
    log("http.upstream-error", { host: target.host, port: target.port, reason, status });
    sendProxyError(res, status, titleForStatus(status), detailForReason(target, reason));
  });
  res.on("error", () => {});
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  req.on("error", () => upstream.destroy());
  req.pipe(upstream);
}

function toHeaderRecord(rawHeaders: string[]): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    const existing = record[name];
    if (existing === undefined) {
      record[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      record[name] = [existing, value];
    }
  }
  return record;
}

function handleConnect(
  input: {
    req: IncomingMessage;
    socket: Socket;
    head: Buffer;
  } & RequestContext,
): void {
  const { req, socket, head, isAuthorized, openStream, log } = input;
  socket.on("error", () => {});
  if (!isAuthorized(req)) {
    writeRawResponse(socket, 407, "Proxy Authentication Required");
    return;
  }
  const target = parseConnectTarget(req.url);
  if (!target) {
    writeRawResponse(socket, 400, "Bad Request");
    return;
  }

  let connected = false;
  let handle: TunnelStreamHandle | null = null;
  let pendingWriteBytes = 0;
  const handleClosed = (reason: number) => {
    if (!connected) {
      const status = httpStatusForTunnelCloseReason(reason);
      log("connect.failed", { host: target.host, port: target.port, reason, status });
      writeRawResponse(socket, status, titleForStatus(status));
      return;
    }
    socket.end();
  };
  handle = openStream(target, {
    onConnected: () => {
      connected = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) {
        forward(head);
      }
      socket.on("data", forward);
      socket.resume();
    },
    onData: (data, consumed) => {
      // Credit returns only after Chromium's socket accepted the bytes.
      socket.write(Buffer.from(data.buffer, data.byteOffset, data.byteLength), (error) => {
        if (!error) consumed();
      });
    },
    onClose: handleClosed,
  });
  if (!handle) {
    writeRawResponse(socket, 503, "Service Unavailable");
    return;
  }
  const stream = handle;
  socket.pause();

  function forward(chunk: Buffer): void {
    pendingWriteBytes += chunk.length;
    if (pendingWriteBytes >= MAX_PENDING_SOCKET_WRITE_BYTES) socket.pause();
    stream.write(chunk, (error) => {
      pendingWriteBytes -= chunk.length;
      if (error) {
        socket.destroy();
        return;
      }
      if (pendingWriteBytes < MAX_PENDING_SOCKET_WRITE_BYTES && !socket.destroyed) socket.resume();
    });
  }
  socket.once("close", () => {
    stream.close(TunnelCloseReason.Ok);
  });
  socket.once("end", () => {
    stream.close(TunnelCloseReason.Ok);
  });
}
