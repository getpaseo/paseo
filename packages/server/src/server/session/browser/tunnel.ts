import http from "node:http";
import https from "node:https";
import net, { type Socket } from "node:net";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { SessionDelivery } from "../owned-subscriptions/index.js";

export function tunnelOrigin(value: string): URL {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.hostname.endsWith(".localhost")) ||
    url.href !== url.origin + "/"
  )
    throw new Error("Only local website origins can be tunneled");
  return url;
}

// Node owns HTTP framing, keep-alive and upgrades; the PandaOS transport only carries bytes.
export async function openWebsiteSocket(origin: URL, localOrigin: URL): Promise<Socket> {
  const transport = origin.protocol === "https:" ? https : http;
  const mapToHost = (value: string | undefined) =>
    value?.replace(localOrigin.origin, origin.origin);
  const headers = (request: http.IncomingMessage) => ({
    ...request.headers,
    host: origin.host,
    ...(request.headers.origin ? { origin: mapToHost(request.headers.origin) } : {}),
    ...(request.headers.referer ? { referer: mapToHost(request.headers.referer) } : {}),
  });
  const target = (request: http.IncomingMessage) => {
    const url = new URL(request.url ?? "/", origin);
    if (url.origin !== origin.origin) throw new Error("Tunnel request changed origin");
    // .localhost names identify daemon service routes but always connect over loopback.
    return {
      hostname: origin.hostname === "[::1]" ? "::1" : "127.0.0.1",
      port: origin.port || (origin.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: request.method,
      headers: headers(request),
      ...(origin.protocol === "https:" ? { servername: origin.hostname } : {}),
    };
  };
  const server = http.createServer((request, response) => {
    let upstream: http.ClientRequest;
    try {
      upstream = transport.request(target(request), (incoming) => {
        const responseHeaders = { ...incoming.headers };
        if (responseHeaders.location)
          responseHeaders.location = responseHeaders.location.replace(
            origin.origin,
            localOrigin.origin,
          );
        response.writeHead(incoming.statusCode ?? 502, responseHeaders);
        incoming.pipe(response);
        incoming.on("error", () => response.destroy());
      });
    } catch {
      response.writeHead(400).end();
      return;
    }
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.on("aborted", () => upstream.destroy());
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  server.on("upgrade", (request, socket, head) => {
    let upstream: http.ClientRequest;
    try {
      upstream = transport.request(target(request));
    } catch {
      socket.destroy();
      return;
    }
    upstream.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` +
          response.rawHeaders.reduce(
            (text, value, index, all) =>
              index % 2 ? text : text + value + ": " + all[index + 1] + "\r\n",
            "",
          ) +
          "\r\n",
      );
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      socket.pipe(remote).pipe(socket);
      socket.on("close", () => remote.destroy());
      remote.on("error", () => socket.destroy());
    });
    upstream.on("response", (response) => {
      socket.end(
        `HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
      );
      response.resume();
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Tunnel listener unavailable");
  const socket = net.createConnection({ host: "127.0.0.1", port: address.port });
  socket.pause();
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  server.close();
  socket.once("close", () => server.closeAllConnections());
  return socket;
}

export class BrowserTunnelSession {
  private readonly streams = new Map<
    string,
    { source: object; socket: Socket; release: () => Promise<void>; resume: () => void }
  >();
  constructor(
    private readonly options: {
      allows: (input: { workspaceId: string; browserId: string; origin: string }) => boolean;
      emit: (message: SessionOutboundMessage) => void;
    },
  ) {}
  async connect(
    request: Extract<SessionInboundMessage, { type: "browser.tunnel.connect.request" }>,
    delivery: SessionDelivery,
  ): Promise<void> {
    let socket: Socket | undefined;
    try {
      const origin = tunnelOrigin(request.origin);
      const localOrigin = tunnelOrigin(request.localOrigin);
      if (localOrigin.protocol !== "http:" || localOrigin.hostname !== "127.0.0.1")
        throw new Error("Invalid device tunnel origin");
      if (!this.options.allows({ ...request, origin: origin.origin }))
        throw new Error("Website does not belong to this browser");
      if (this.streams.size >= 32) throw new Error("Too many website connections");
      const owner = delivery.begin("browser-tunnel", undefined, () => {
        socket?.destroy();
        this.streams.delete(owner.responseId);
      });
      try {
        socket = await openWebsiteSocket(origin, localOrigin);
      } catch (error) {
        await owner.release();
        throw error;
      }
      if (owner.signal.aborted) {
        socket.destroy();
        return;
      }
      const streamSocket = socket;
      let waiting = true;
      const pump = () => {
        if (waiting || !streamSocket.readableLength) return;
        const data: Buffer | null = streamSocket.read(Math.min(32768, streamSocket.readableLength));
        if (!data) return;
        waiting = true;
        owner.emit({
          type: "browser.tunnel.data",
          payload: { dataBase64: data.toString("base64") },
        });
      };
      this.streams.set(owner.responseId, {
        source: owner.source,
        socket,
        release: owner.release,
        resume: () => {
          waiting = false;
          pump();
        },
      });
      socket.on("readable", pump);
      socket.on("error", (error) =>
        owner.emit({ type: "browser.tunnel.data", payload: { error: error.message } }),
      );
      socket.on("close", () => {
        owner.emit({ type: "browser.tunnel.data", payload: { ended: true } });
        void owner.release();
      });
      this.options.emit({
        type: "browser.tunnel.connect.response",
        payload: { requestId: request.requestId, subscriptionId: owner.responseId, error: null },
      });
    } catch (error) {
      socket?.destroy();
      this.options.emit({
        type: "browser.tunnel.connect.response",
        payload: {
          requestId: request.requestId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  async operate(
    request: Extract<SessionInboundMessage, { type: "browser.tunnel.socket.request" }>,
    source?: object,
  ): Promise<void> {
    let error: string | null = null;
    try {
      const stream = this.streams.get(request.subscriptionId);
      if (!stream || stream.source !== source) throw new Error("Website connection is closed");
      if (request.operation === "close") await stream.release();
      else if (request.operation === "resume") stream.resume();
      else {
        const encoded = request.dataBase64;
        if (
          encoded === undefined ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
        )
          throw new Error("Invalid website bytes");
        const bytes = Buffer.from(encoded, "base64");
        if (bytes.length > 32768) throw new Error("Website chunk too large");
        await new Promise<void>((resolve, reject) =>
          stream.socket.write(bytes, (err) => {
            if (err) reject(err);
            else resolve();
          }),
        );
      }
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    this.options.emit({
      type: "browser.tunnel.socket.response",
      payload: { requestId: request.requestId, error },
    });
  }
}
