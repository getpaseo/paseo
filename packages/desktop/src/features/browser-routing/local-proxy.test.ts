import http, { type IncomingMessage } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { TunnelCloseReason } from "@getpaseo/protocol/binary-frames/tunnel";
import { afterEach, describe, expect, test } from "vitest";
import {
  BROWSER_PROXY_WARMUP_HOST,
  startLocalBrowserProxy,
  TunnelDuplex,
  TunnelStreamError,
  type LocalBrowserProxy,
  type LocalBrowserProxyOptions,
  type LocalProxyDiagnostics,
  type OpenTunnelStream,
  type ProxyCredential,
  type ProxyTarget,
  type TunnelStreamSink,
} from "./local-proxy.js";

const CREDENTIAL: ProxyCredential = { username: "paseo-test", password: "secret-value" };
const AUTHORIZATION = `Basic ${Buffer.from("paseo-test:secret-value").toString("base64")}`;

interface Cleanup {
  (): Promise<void> | void;
}

const cleanups: Cleanup[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function listenPort(server: net.Server | http.Server): number {
  return (server.address() as AddressInfo).port;
}

const FAKE_DAEMON_WINDOW_BYTES = 64 * 1024;

/**
 * Fake daemon side: every tunnel stream is a real TCP connection opened here. The
 * origin socket pauses once `windowBytes` are unacknowledged, as the daemon's
 * credit window does; `windowBytes: 0` pauses after every chunk until its credit
 * returns.
 */
function tcpTunnel(options: { log?: ProxyTarget[]; windowBytes?: number } = {}): OpenTunnelStream {
  const windowBytes = Math.max(options.windowBytes ?? FAKE_DAEMON_WINDOW_BYTES, 1);
  return (target, sink) => {
    options.log?.push(target);
    const socket = net.connect(target.port, target.host);
    let closed = false;
    let outstanding = 0;
    const close = (reason: number) => {
      if (closed) return;
      closed = true;
      sink.onClose(reason);
    };
    socket.on("connect", () => sink.onConnected());
    socket.on("data", (chunk) => {
      outstanding += chunk.length;
      if (outstanding >= windowBytes) socket.pause();
      sink.onData(chunk, () => {
        outstanding -= chunk.length;
        if (outstanding < windowBytes) socket.resume();
      });
    });
    socket.on("end", () => close(TunnelCloseReason.Ok));
    socket.on("close", () => close(TunnelCloseReason.Ok));
    socket.on("error", (error: NodeJS.ErrnoException) => {
      close(
        error.code === "ECONNREFUSED"
          ? TunnelCloseReason.ConnectionRefused
          : TunnelCloseReason.GeneralError,
      );
    });
    return {
      write: (data, callback) => {
        socket.write(data, callback);
      },
      close: () => {
        closed = true;
        socket.destroy();
      },
    };
  };
}

/** Pending writes fail with the close reason, as the real bridge does. */
function failingTunnel(reason: number): OpenTunnelStream {
  return (_target, sink) => {
    queueMicrotask(() => sink.onClose(reason));
    return {
      write: (_data, callback) => callback(new TunnelStreamError(reason)),
      close: () => {},
    };
  };
}

/** Tunnel that records sinks and reports Connected without any socket behind it. */
function capturingTunnel(sinks: TunnelStreamSink[]): OpenTunnelStream {
  return (_target, sink) => {
    sinks.push(sink);
    queueMicrotask(() => sink.onConnected());
    return { write: (_d, cb) => cb(), close: () => {} };
  };
}

/** Tunnel that records targets and always reports the host as unknown. */
function recordingHostNotFoundTunnel(targets: ProxyTarget[]): OpenTunnelStream {
  return (target, sink) => {
    targets.push(target);
    queueMicrotask(() => sink.onClose(TunnelCloseReason.HostNotFound));
    return { write: (_d, cb) => cb(), close: () => {} };
  };
}

function echoConnection(socket: Socket): void {
  socket.on("data", (chunk) => socket.write(Buffer.from(`echo:${chunk.toString()}`)));
}

interface SeenRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function recordingOriginHandler(
  seen: SeenRequest[],
): (req: IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      res.writeHead(201, { "Content-Type": "text/plain", "X-Origin": "yes" });
      res.end("created");
    });
  };
}

/** Origin that answers 103 at once and the final response only when released. */
function heldResponseOrigin(state: {
  seen: string[];
  release: () => void;
}): (req: IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    state.seen.push(req.url ?? "");
    res.writeEarlyHints({ link: "</style.css>; rel=preload; as=style" });
    state.release = () => res.end("done");
  };
}

function rawRequest(input: { originPort: number; path: string; authorization?: string }): string {
  return [
    `GET http://127.0.0.1:${input.originPort}${input.path} HTTP/1.1`,
    `Host: 127.0.0.1:${input.originPort}`,
    `Proxy-Authorization: ${input.authorization ?? AUTHORIZATION}`,
    "Proxy-Connection: keep-alive",
    "",
    "",
  ].join("\r\n");
}

async function connectRaw(
  port: number,
): Promise<{ socket: Socket; wire: () => string; closed: () => boolean }> {
  const socket = net.connect(port, "127.0.0.1");
  cleanups.push(() => socket.destroy());
  let wire = "";
  let closed = false;
  socket.on("data", (chunk) => {
    wire += chunk.toString();
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    closed = true;
  });
  await once(socket, "connect");
  return { socket, wire: () => wire, closed: () => closed };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function earlyHintsConnection(counter: { connections: number }): (socket: Socket) => void {
  return (socket) => {
    counter.connections += 1;
    socket.once("data", () => {
      socket.write(
        "HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload; as=style\r\n\r\n" +
          "HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: keep-alive\r\n\r\nhello",
      );
    });
  };
}

async function startProxy(
  openStream: OpenTunnelStream,
  options: Pick<LocalBrowserProxyOptions, "log"> = {},
): Promise<LocalBrowserProxy> {
  const proxy = await startLocalBrowserProxy({ openStream, credential: CREDENTIAL, ...options });
  cleanups.push(() => proxy.close());
  return proxy;
}

async function startOrigin(
  handler: (req: IncomingMessage, res: http.ServerResponse) => void,
): Promise<http.Server> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.on("connection", (socket) => cleanups.push(() => socket.destroy()));
  return server;
}

async function startRawOrigin(onConnection: (socket: Socket) => void): Promise<net.Server> {
  const server = net.createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  server.on("connection", (socket) => cleanups.push(() => socket.destroy()));
  return server;
}

interface ProxiedResponse {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  informational: number[];
  socketClosed: Promise<void>;
}

function requestThroughProxy(input: {
  proxyPort: number;
  url: string;
  method?: string;
  authorization?: string | null;
  headers?: Record<string, string>;
  body?: string;
}): Promise<ProxiedResponse> {
  return new Promise((resolve, reject) => {
    const informational: number[] = [];
    const request = http.request({
      host: "127.0.0.1",
      port: input.proxyPort,
      method: input.method ?? "GET",
      path: input.url,
      headers: {
        Host: input.url.startsWith("/") ? "proxy.invalid" : new URL(input.url).host,
        ...(input.authorization === null
          ? {}
          : { "Proxy-Authorization": input.authorization ?? AUTHORIZATION }),
        "Proxy-Connection": "keep-alive",
        ...input.headers,
      },
    });
    request.on("information", (info) => informational.push(info.statusCode));
    request.on("response", (response) => {
      const socketClosed = new Promise<void>((resolveClosed) => {
        response.socket?.once("close", () => resolveClosed());
      });
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body,
          informational,
          socketClosed,
        }),
      );
    });
    request.on("error", reject);
    request.end(input.body);
  });
}

function connectThroughProxy(input: {
  proxyPort: number;
  target: string;
  authorization?: string | null;
}): Promise<{ statusCode: number; socket: Socket; head: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port: input.proxyPort,
      method: "CONNECT",
      path: input.target,
      headers:
        input.authorization === null
          ? {}
          : { "Proxy-Authorization": input.authorization ?? AUTHORIZATION },
    });
    request.on("connect", (response, socket, head) => {
      cleanups.push(() => socket.destroy());
      resolve({ statusCode: response.statusCode ?? 0, socket, head });
    });
    request.on("response", (response) => {
      response.resume();
      resolve({
        statusCode: response.statusCode ?? 0,
        socket: request.socket as Socket,
        head: Buffer.alloc(0),
      });
    });
    request.on("error", reject);
    request.end();
  });
}

describe("local browser proxy: CONNECT", () => {
  test("demands the per-run credential before opening a tunnel", async () => {
    const targets: ProxyTarget[] = [];
    const proxy = await startProxy(tcpTunnel({ log: targets }));

    const missing = await connectThroughProxy({
      proxyPort: proxy.port,
      target: "intranet.invalid:443",
      authorization: null,
    });
    const wrong = await connectThroughProxy({
      proxyPort: proxy.port,
      target: "intranet.invalid:443",
      authorization: `Basic ${Buffer.from("paseo-test:wrong").toString("base64")}`,
    });

    expect(missing.statusCode).toBe(407);
    expect(wrong.statusCode).toBe(407);
    expect(targets).toEqual([]);
  });

  test("answers 200 only after the tunnel connected and then pipes raw bytes both ways", async () => {
    const echo = await startRawOrigin(echoConnection);
    const targets: ProxyTarget[] = [];
    const proxy = await startProxy(tcpTunnel({ log: targets }));

    const { statusCode, socket } = await connectThroughProxy({
      proxyPort: proxy.port,
      target: `127.0.0.1:${listenPort(echo)}`,
    });
    expect(statusCode).toBe(200);
    expect(targets).toEqual([{ host: "127.0.0.1", port: listenPort(echo) }]);

    socket.write("hello");
    const [reply] = (await once(socket, "data")) as [Buffer];
    expect(reply.toString()).toBe("echo:hello");

    socket.write("again");
    const [second] = (await once(socket, "data")) as [Buffer];
    expect(second.toString()).toBe("echo:again");
  });

  test("passes IPv6 literals and hostnames to the tunnel unresolved", async () => {
    const targets: ProxyTarget[] = [];
    const proxy = await startProxy(recordingHostNotFoundTunnel(targets));

    await connectThroughProxy({ proxyPort: proxy.port, target: "[::1]:8443" });
    await connectThroughProxy({ proxyPort: proxy.port, target: "app.localhost:5173" });

    expect(targets).toEqual([
      { host: "::1", port: 8443 },
      { host: "app.localhost", port: 5173 },
    ]);
  });

  test.each([
    [TunnelCloseReason.PolicyDenied, 403],
    [TunnelCloseReason.HostNotFound, 502],
    [TunnelCloseReason.ConnectionRefused, 502],
    [TunnelCloseReason.Timeout, 504],
    [TunnelCloseReason.StreamLimit, 503],
  ])("maps close reason %i before connect to HTTP %i", async (reason, status) => {
    const proxy = await startProxy(failingTunnel(reason));
    const result = await connectThroughProxy({
      proxyPort: proxy.port,
      target: "intranet.invalid:443",
    });
    expect(result.statusCode).toBe(status);
  });

  test("answers 503 when no provider is registered", async () => {
    const proxy = await startProxy(() => null);
    const result = await connectThroughProxy({
      proxyPort: proxy.port,
      target: "intranet.invalid:443",
    });
    expect(result.statusCode).toBe(503);
  });

  test("rejects malformed CONNECT targets", async () => {
    const proxy = await startProxy(tcpTunnel());
    const result = await connectThroughProxy({ proxyPort: proxy.port, target: "no-port" });
    expect(result.statusCode).toBe(400);
  });
});

describe("local browser proxy: plain HTTP", () => {
  test("forwards an absolute-URI request without proxy headers and closes after the response", async () => {
    const seen: SeenRequest[] = [];
    const origin = await startOrigin(recordingOriginHandler(seen));
    const proxy = await startProxy(tcpTunnel());

    const response = await requestThroughProxy({
      proxyPort: proxy.port,
      url: `http://127.0.0.1:${listenPort(origin)}/items?x=1`,
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Custom": "kept" },
      body: '{"a":1}',
    });

    expect(response.statusCode).toBe(201);
    expect(response.body).toBe("created");
    expect(response.headers["x-origin"]).toBe("yes");
    expect(response.headers.connection).toBe("close");
    await response.socketClosed;

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/items?x=1");
    expect(seen[0].body).toBe('{"a":1}');
    expect(seen[0].headers["proxy-authorization"]).toBeUndefined();
    expect(seen[0].headers["proxy-connection"]).toBeUndefined();
    expect(seen[0].headers["x-custom"]).toBe("kept");
    expect(seen[0].headers.host).toBe(`127.0.0.1:${listenPort(origin)}`);
  });

  test("requires the credential on every request", async () => {
    const targets: ProxyTarget[] = [];
    const proxy = await startProxy(tcpTunnel({ log: targets }));

    const response = await requestThroughProxy({
      proxyPort: proxy.port,
      url: "http://intranet.invalid/",
      authorization: null,
    });

    expect(response.statusCode).toBe(407);
    expect(response.headers["proxy-authenticate"]).toMatch(/^Basic realm=/);
    expect(targets).toEqual([]);
  });

  test("relays 103 Early Hints before the final response without reusing the connection", async () => {
    const counter = { connections: 0 };
    const origin = await startRawOrigin(earlyHintsConnection(counter));
    const proxy = await startProxy(tcpTunnel());
    const url = `http://127.0.0.1:${listenPort(origin)}/page`;

    const first = await requestThroughProxy({ proxyPort: proxy.port, url });
    expect(first.informational).toEqual([103]);
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe("hello");
    await first.socketClosed;

    const second = await requestThroughProxy({ proxyPort: proxy.port, url });
    expect(second.statusCode).toBe(200);
    expect(counter.connections).toBe(2);
  });

  test("never forwards a second request pipelined on the same connection", async () => {
    const state = { seen: [] as string[], release: () => {} };
    const origin = await startOrigin(heldResponseOrigin(state));
    const targets: ProxyTarget[] = [];
    const refused: Array<Record<string, unknown>> = [];
    const proxy = await startProxy(tcpTunnel({ log: targets }), {
      log: (event, details) => {
        if (event === "http.extra-request-refused") refused.push(details);
      },
    });
    const originPort = listenPort(origin);

    const { socket, wire, closed } = await connectRaw(proxy.port);
    socket.write(rawRequest({ originPort, path: "/first" }));
    await waitFor(() => wire().includes("103 Early Hints"));
    socket.write(rawRequest({ originPort, path: "/second" }));
    // The refusal is logged once the proxy parsed the second request: by then it
    // either opened a stream for it or never will.
    await waitFor(() => refused.length === 1);
    expect(refused).toEqual([{ host: "127.0.0.1", port: originPort }]);
    expect(targets).toEqual([{ host: "127.0.0.1", port: originPort }]);
    expect(state.seen).toEqual(["/first"]);

    state.release();
    await waitFor(closed);
    expect(wire()).toContain("HTTP/1.1 200 OK");
    expect(wire()).toContain("done");
    expect(wire().match(/HTTP\/1\.1 200/g)).toHaveLength(1);
    expect(targets).toHaveLength(1);
    expect(state.seen).toEqual(["/first"]);
  });

  test("closes the connection after the final response instead of serving a retry on it", async () => {
    const state = { seen: [] as string[], release: () => {} };
    const origin = await startOrigin(heldResponseOrigin(state));
    const targets: ProxyTarget[] = [];
    const proxy = await startProxy(tcpTunnel({ log: targets }));
    const originPort = listenPort(origin);

    const { socket, wire, closed } = await connectRaw(proxy.port);
    socket.write(rawRequest({ originPort, path: "/first" }));
    await waitFor(() => wire().includes("103 Early Hints"));
    state.release();
    await waitFor(() => wire().includes("done"));
    socket.write(rawRequest({ originPort, path: "/second" }));

    // Once the proxy closed the connection it reads nothing more from it, so every
    // stream it was ever going to open for this socket is already in `targets`.
    await waitFor(closed);
    expect(targets).toEqual([{ host: "127.0.0.1", port: originPort }]);
    expect(state.seen).toEqual(["/first"]);
  });

  test("returns the credit of a 103 chunk without waiting for body bytes", async () => {
    const state = { seen: [] as string[], release: () => {} };
    const origin = await startOrigin(heldResponseOrigin(state));
    // Window 0: the origin stays paused until every chunk's credit came back.
    const proxy = await startProxy(tcpTunnel({ windowBytes: 0 }));

    const responsePromise = requestThroughProxy({
      proxyPort: proxy.port,
      url: `http://127.0.0.1:${listenPort(origin)}/hinted`,
    });
    await waitFor(() => state.seen.length === 1);
    state.release();
    const response = await responsePromise;

    expect(response.informational).toEqual([103]);
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("done");
  });

  test("answers the warm-up host locally without opening a stream", async () => {
    const targets: ProxyTarget[] = [];
    const proxy = await startProxy(tcpTunnel({ log: targets }));

    const response = await requestThroughProxy({
      proxyPort: proxy.port,
      url: `http://${BROWSER_PROXY_WARMUP_HOST}/`,
    });

    expect(response.statusCode).toBe(204);
    expect(targets).toEqual([]);
  });

  test("answers 503 without a provider and never touches the local network", async () => {
    const proxy = await startProxy(() => null);
    const response = await requestThroughProxy({
      proxyPort: proxy.port,
      url: "http://localhost:3000/",
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("503");
  });

  test.each([
    [TunnelCloseReason.PolicyDenied, 403],
    [TunnelCloseReason.HostNotFound, 502],
    [TunnelCloseReason.Timeout, 504],
    [TunnelCloseReason.StreamLimit, 503],
  ])("maps close reason %i before connect to an HTML %i page", async (reason, status) => {
    const proxy = await startProxy(failingTunnel(reason));
    const response = await requestThroughProxy({
      proxyPort: proxy.port,
      url: "http://intranet.invalid/",
    });
    expect(response.statusCode).toBe(status);
    expect(response.headers["content-type"]).toContain("text/html");
  });

  test("rejects origin-form requests and non-http schemes", async () => {
    const proxy = await startProxy(tcpTunnel());
    const originForm = await requestThroughProxy({ proxyPort: proxy.port, url: "/relative" });
    const https = await requestThroughProxy({
      proxyPort: proxy.port,
      url: "https://intranet.invalid/",
    });
    expect(originForm.statusCode).toBe(400);
    expect(https.statusCode).toBe(400);
  });

  test("refuses Upgrade requests outside CONNECT", async () => {
    const proxy = await startProxy(tcpTunnel());
    const socket = net.connect(proxy.port, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    await once(socket, "connect");
    socket.write(
      `GET http://intranet.invalid/ws HTTP/1.1\r\nHost: intranet.invalid\r\nProxy-Authorization: ${AUTHORIZATION}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    );
    const [reply] = (await once(socket, "data")) as [Buffer];
    expect(reply.toString()).toMatch(/^HTTP\/1\.1 501 /);
  });
});

interface CreditEvent {
  kind: "issued" | "completed" | "credit";
  bytes: number;
}

const INFORMATIONAL_SHAPES: Record<string, string[]> = {
  "no 1xx": [],
  "103 with Link": [
    "HTTP/1.1 103 Early Hints\r\nLink: </style.css>; rel=preload; as=style\r\n\r\n",
  ],
  "103 without Link": ["HTTP/1.1 103 Early Hints\r\n\r\n"],
  "100 Continue": ["HTTP/1.1 100 Continue\r\n\r\n"],
  "103 with Link then 103 without Link": [
    "HTTP/1.1 103 Early Hints\r\nLink: </a.css>; rel=preload; as=style\r\n\r\n",
    "HTTP/1.1 103 Early Hints\r\n\r\n",
  ],
};
const FINAL_RESPONSE = "HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\npayload";

function creditedBytes(events: CreditEvent[]): number {
  return events
    .filter((event) => event.kind === "credit")
    .reduce((total, event) => total + event.bytes, 0);
}

function recordingDiagnostics(events: CreditEvent[]): LocalProxyDiagnostics {
  return {
    localWriteIssued: (bytes) => events.push({ kind: "issued", bytes }),
    localWriteCompleted: (bytes) => events.push({ kind: "completed", bytes }),
  };
}

function chunkLayouts(pieces: string[]): Record<string, Buffer[]> {
  const joined = Buffer.from(pieces.join(""));
  const sliced: Buffer[] = [];
  for (let offset = 0; offset < joined.length; offset += 10) {
    sliced.push(joined.subarray(offset, offset + 10));
  }
  return {
    "same chunk": [joined],
    "separate chunks": pieces.map((piece) => Buffer.from(piece)),
    "10-byte slices": sliced,
  };
}

describe("local browser proxy: credit accounting across 1xx shapes", () => {
  for (const [shape, informational] of Object.entries(INFORMATIONAL_SHAPES)) {
    for (const [layout, chunks] of Object.entries(
      chunkLayouts([...informational, FINAL_RESPONSE]),
    )) {
      test(`${shape}, ${layout}: credit equals delivered bytes and follows the last local write`, async () => {
        const events: CreditEvent[] = [];
        const sinks: TunnelStreamSink[] = [];
        const proxy = await startLocalBrowserProxy({
          openStream: capturingTunnel(sinks),
          credential: CREDENTIAL,
          diagnostics: recordingDiagnostics(events),
        });
        cleanups.push(() => proxy.close());
        const { socket, wire, closed } = await connectRaw(proxy.port);
        socket.write(rawRequest({ originPort: 80, path: "/shape" }));
        await waitFor(() => sinks.length === 1);

        const delivered = chunks.reduce((total, chunk) => total + chunk.length, 0);
        for (const chunk of chunks) {
          sinks[0].onData(chunk, () => events.push({ kind: "credit", bytes: chunk.length }));
        }
        expect(events.filter((event) => event.kind === "credit")).toEqual([]);

        await waitFor(closed);
        await waitFor(() => creditedBytes(events) === delivered);

        expect(wire()).toContain("payload");
        expect(wire().includes("103 Early Hints")).toBe(shape.includes("with Link"));
        const credits = events
          .filter((event) => event.kind === "credit")
          .map((event) => event.bytes);
        expect(credits).toEqual(chunks.map((chunk) => chunk.length));
        // At every credit, no local write is pending: issued and completed match.
        let issued = 0;
        let completed = 0;
        for (const event of events) {
          if (event.kind === "issued") issued += 1;
          if (event.kind === "completed") completed += 1;
          if (event.kind === "credit") expect(issued).toBe(completed);
        }
        expect(issued).toBeGreaterThan(0);
        expect(issued).toBe(completed);
      });
    }
  }
});

describe("local browser proxy: inbound credit", () => {
  test("a chunk's credit waits for the local write it produced, then returns exactly once", async () => {
    const duplex = new TunnelDuplex(undefined);
    const credits: number[] = [];
    // The parser side: every chunk read produces one local write whose callback we hold.
    const completions: Array<() => void> = [];
    duplex.on("data", (chunk: Buffer) => {
      completions.push(duplex.trackLocalWrite(chunk.length));
    });

    duplex.sink.onData(Buffer.from("first"), () => credits.push(5));
    duplex.sink.onData(Buffer.from("second!"), () => credits.push(7));
    await waitFor(() => completions.length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    // Parsed, but the write is still pending: no credit, and the next chunk waits.
    expect(credits).toEqual([]);
    expect(completions).toHaveLength(1);

    completions[0]();
    expect(credits).toEqual([5]);
    await waitFor(() => completions.length === 2);
    await new Promise((resolve) => setImmediate(resolve));
    expect(credits).toEqual([5]);

    completions[1]();
    completions[1]();
    expect(credits).toEqual([5, 7]);
  });

  test("a chunk that produces no local write is credited once it is parsed", async () => {
    const duplex = new TunnelDuplex(undefined);
    const credits: number[] = [];
    duplex.on("data", () => {});

    duplex.sink.onData(Buffer.from("quiet"), () => credits.push(5));
    expect(credits).toEqual([]);
    await waitFor(() => credits.length === 1);
    expect(credits).toEqual([5]);
  });

  test("plain HTTP credits every chunk only after its local write completed", async () => {
    const sinks: TunnelStreamSink[] = [];
    const events: CreditEvent[] = [];
    const proxy = await startLocalBrowserProxy({
      openStream: capturingTunnel(sinks),
      credential: CREDENTIAL,
      diagnostics: recordingDiagnostics(events),
    });
    cleanups.push(() => proxy.close());
    const { socket, wire } = await connectRaw(proxy.port);
    socket.write(rawRequest({ originPort: 80, path: "/big" }));
    await waitFor(() => sinks.length === 1);

    const chunkBytes = 64 * 1024;
    const chunkCount = 64;
    let credited = 0;
    const credit = () => {
      credited += 1;
      events.push({ kind: "credit", bytes: 0 });
    };
    sinks[0].onData(
      Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${chunkBytes * chunkCount}\r\n\r\n`),
      credit,
    );
    for (let index = 0; index < chunkCount; index += 1) {
      sinks[0].onData(Buffer.alloc(chunkBytes, index % 256), credit);
    }
    expect(credited).toBe(0);

    let received = 0;
    socket.on("data", (chunk) => {
      received += chunk.length;
    });
    await waitFor(() => received >= chunkBytes * chunkCount, 10_000);
    await waitFor(() => credited === chunkCount + 1, 5_000);
    expect(wire().length).toBeGreaterThan(0);
    // At every credit, no local write was pending.
    let issued = 0;
    let completed = 0;
    for (const event of events) {
      if (event.kind === "issued") issued += 1;
      if (event.kind === "completed") completed += 1;
      if (event.kind === "credit") expect(issued).toBe(completed);
    }
    expect(issued).toBe(completed);
  });

  test("acknowledges tunnel data only after the proxy delivered it", async () => {
    const sinks: TunnelStreamSink[] = [];
    const proxy = await startProxy(capturingTunnel(sinks));

    const { statusCode, socket } = await connectThroughProxy({
      proxyPort: proxy.port,
      target: "intranet.invalid:443",
    });
    expect(statusCode).toBe(200);

    let consumed = 0;
    sinks[0].onData(Buffer.from("payload"), () => {
      consumed += 1;
    });
    const [received] = (await once(socket, "data")) as [Buffer];
    expect(received.toString()).toBe("payload");
    await new Promise((resolve) => setImmediate(resolve));
    expect(consumed).toBe(1);
  });
});
