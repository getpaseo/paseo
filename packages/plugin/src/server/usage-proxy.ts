import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as tcpConnect, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

export interface UsageProxyOptions {
  /** Defaults to `process.env`. Override in tests. */
  env?: NodeJS.ProcessEnv;
  /** Loopback host probed when no proxy env var is set. Defaults to "127.0.0.1". */
  probeHost?: string;
  /** Loopback port probed when no proxy env var is set. Defaults to 7890. */
  probePort?: number;
  /** TCP probe timeout in milliseconds. Defaults to 500. */
  probeTimeoutMs?: number;
  /** Timeout for a direct request when the caller supplies no signal. Defaults to 15_000. */
  requestTimeoutMs?: number;
  /** Maximum time spent on the proxy path before trying direct. Defaults to 5_000. */
  proxyAttemptTimeoutMs?: number;
}

const DEFAULT_PROXY_PROBE_HOST = "127.0.0.1";
const DEFAULT_PROXY_PROBE_PORT = 7890;
const DEFAULT_PROXY_PROBE_TIMEOUT_MS = 500;
const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_PROXY_ATTEMPT_TIMEOUT_MS = 5_000;
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;

function proxyEnv(env: NodeJS.ProcessEnv): string | null {
  for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

function normalizeProxyUrl(raw: string): string | null {
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function defaultPort(protocol: string): string {
  if (protocol === "https:") return "443";
  if (protocol === "http:") return "80";
  return "";
}

interface NoProxyEntry {
  host: string;
  port: string | null;
}

function parseNoProxyEntry(raw: string): NoProxyEntry | null {
  const entry = raw.trim().toLowerCase();
  if (!entry || entry === "*") return null;

  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    if (close === -1) return { host: stripIpv6Brackets(entry), port: null };
    const host = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    return { host, port: /^:\d+$/.test(rest) ? rest.slice(1) : null };
  }

  const firstColon = entry.indexOf(":");
  const lastColon = entry.lastIndexOf(":");
  if (firstColon !== -1 && firstColon === lastColon) {
    const possiblePort = entry.slice(lastColon + 1);
    if (/^\d+$/.test(possiblePort)) {
      return { host: entry.slice(0, lastColon).replace(/^\./, ""), port: possiblePort };
    }
  }

  return { host: entry.replace(/^\./, ""), port: null };
}

/** Whether a target is excluded from proxying by `NO_PROXY`/`no_proxy`. */
export function isProxyBypassed(
  target: URL | string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = env["NO_PROXY"] ?? env["no_proxy"];
  if (!raw) return false;

  let hostname: string;
  let port = "";
  if (target instanceof URL) {
    hostname = stripIpv6Brackets(target.hostname).toLowerCase();
    port = target.port || defaultPort(target.protocol);
  } else {
    hostname = stripIpv6Brackets(target).toLowerCase();
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .some((rawEntry) => {
      if (rawEntry === "*") return true;
      const entry = parseNoProxyEntry(rawEntry);
      if (!entry) return false;
      if (entry.port !== null && entry.port !== port) return false;
      if (hostname === entry.host) return true;
      if (isIP(entry.host) !== 0) return false;
      return hostname.endsWith(`.${entry.host}`);
    });
}

function isTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

/** Resolve the proxy URL for usage traffic, or null when requests should go direct. */
export async function resolveUsageProxyUrl(
  options: UsageProxyOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const fromEnv = proxyEnv(env);
  if (fromEnv) return normalizeProxyUrl(fromEnv);

  const host = options.probeHost ?? DEFAULT_PROXY_PROBE_HOST;
  const port = options.probePort ?? DEFAULT_PROXY_PROBE_PORT;
  const open = await isTcpPortOpen(
    host,
    port,
    options.probeTimeoutMs ?? DEFAULT_PROXY_PROBE_TIMEOUT_MS,
  );
  return open ? new URL(`http://${host}:${port}`).toString() : null;
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("This operation was aborted", "AbortError");
}

function combineSignals(signals: AbortSignal[]): AbortSignal | undefined {
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

function proxyAuthorizationValue(proxy: URL): string | null {
  if (!proxy.username) return null;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function redactedProxyUrl(proxyUrl: string): string {
  try {
    const proxy = new URL(proxyUrl);
    proxy.username = "";
    proxy.password = "";
    return proxy.toString();
  } catch {
    return "<invalid proxy>";
  }
}

async function serializeBody(body: BodyInit | null | undefined): Promise<Uint8Array | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString());
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  throw new TypeError("Unsupported proxied request body");
}

function responseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    const name = response.rawHeaders[index];
    const value = response.rawHeaders[index + 1];
    if (name && value !== undefined) headers.append(name, value);
  }
  // Node has already decoded HTTP transfer framing before emitting data chunks.
  headers.delete("transfer-encoding");
  headers.delete("connection");
  return headers;
}

function readResponse(response: IncomingMessage): Promise<Response> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      response.destroy(error);
      reject(error);
    };

    const declaredLength = Number(response.headers["content-length"] ?? 0);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_PROXY_BODY_BYTES) {
      fail(new Error("Proxy response body exceeds limit"));
      return;
    }

    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROXY_BODY_BYTES) {
        fail(new Error("Proxy response body exceeds limit"));
        return;
      }
      chunks.push(chunk);
    });
    response.once("error", fail);
    response.once("aborted", () => fail(new Error("Proxy response aborted")));
    response.once("end", () => {
      if (settled) return;
      settled = true;
      const status = response.statusCode ?? 0;
      if (status < 200 || status > 599) {
        reject(new Error(`Proxy returned invalid status ${status}`));
        return;
      }
      const noBody = status === 204 || status === 304;
      resolve(
        new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks, size)), {
          status,
          statusText: response.statusMessage ?? "",
          headers: responseHeaders(response),
        }),
      );
    });
  });
}

function nodeRequest(
  secure: boolean,
  options: RequestOptions,
  onResponse?: (response: IncomingMessage) => void,
): ClientRequest {
  return secure ? httpsRequest(options, onResponse) : httpRequest(options, onResponse);
}

function headersObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function targetHeaders(target: URL, init: RequestInit): Headers {
  const headers = new Headers(init.headers);
  headers.set("host", target.host);
  headers.set("connection", "close");
  // Proxy credentials are hop credentials and must never enter the origin request.
  headers.delete("proxy-authorization");
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  return headers;
}

async function sendRequest(
  secure: boolean,
  options: RequestOptions,
  body: Uint8Array | null,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = nodeRequest(secure, options, (response) => {
      void readResponse(response).then(resolve, reject);
    });
    request.once("error", reject);
    if (body) request.end(body);
    else request.end();
  });
}

function connectTunnel(proxy: URL, target: URL, signal: AbortSignal): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const targetHost = stripIpv6Brackets(target.hostname);
    const authority = `${targetHost.includes(":") ? `[${targetHost}]` : targetHost}:${target.port || "443"}`;
    const headers: Record<string, string> = { host: authority };
    const proxyAuthorization = proxyAuthorizationValue(proxy);
    if (proxyAuthorization) headers["proxy-authorization"] = proxyAuthorization;

    const request = nodeRequest(proxy.protocol === "https:", {
      hostname: stripIpv6Brackets(proxy.hostname),
      port: proxy.port ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80,
      method: "CONNECT",
      path: authority,
      headers,
      agent: false,
      signal,
    });
    request.once("connect", (response, socket, head) => {
      if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
        socket.destroy();
        reject(
          new Error(`Proxy CONNECT to ${authority} rejected with status ${response.statusCode ?? 0}`),
        );
        return;
      }
      if (head.length > 0) socket.unshift(head);
      resolve(socket);
    });
    request.once("error", reject);
    request.end();
  });
}

function secureTargetSocket(socket: Duplex, target: URL, signal: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      socket.destroy();
      reject(abortError(signal));
      return;
    }
    const hostname = stripIpv6Brackets(target.hostname);
    const secure = tlsConnect({
      socket,
      ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
      ALPNProtocols: ["http/1.1"],
    });
    const onAbort = () => {
      cleanup();
      secure.destroy();
      reject(abortError(signal));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      secure.removeListener("secureConnect", onSecure);
      secure.removeListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onSecure = () => {
      cleanup();
      resolve(secure);
    };
    secure.once("secureConnect", onSecure);
    secure.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function requestHttpTargetThroughProxy(
  target: URL,
  proxy: URL,
  init: RequestInit,
  body: Uint8Array | null,
  signal: AbortSignal,
): Promise<Response> {
  const headers = targetHeaders(target, init);
  const proxyAuthorization = proxyAuthorizationValue(proxy);
  if (proxyAuthorization) headers.set("proxy-authorization", proxyAuthorization);
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));

  return sendRequest(
    proxy.protocol === "https:",
    {
      hostname: stripIpv6Brackets(proxy.hostname),
      port: proxy.port ? Number(proxy.port) : proxy.protocol === "https:" ? 443 : 80,
      method: (init.method ?? "GET").toUpperCase(),
      path: target.toString(),
      headers: headersObject(headers),
      agent: false,
      signal,
    },
    body,
  );
}

async function requestHttpsTargetThroughProxy(
  target: URL,
  proxy: URL,
  init: RequestInit,
  body: Uint8Array | null,
  signal: AbortSignal,
): Promise<Response> {
  const tunnel = await connectTunnel(proxy, target, signal);
  let secure: TLSSocket | null = null;
  try {
    secure = await secureTargetSocket(tunnel, target, signal);
    const headers = targetHeaders(target, init);
    if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));
    const hostname = stripIpv6Brackets(target.hostname);
    return await sendRequest(
      true,
      {
        hostname,
        port: target.port ? Number(target.port) : 443,
        method: (init.method ?? "GET").toUpperCase(),
        path: `${target.pathname}${target.search}` || "/",
        headers: headersObject(headers),
        agent: false,
        signal,
        createConnection: () => secure!,
      },
      body,
    );
  } finally {
    secure?.destroy();
    tunnel.destroy();
  }
}

/** Route one request through an HTTP or HTTPS proxy. */
export async function requestThroughProxy(
  target: URL,
  proxyUrl: string,
  init: RequestInit = {},
  options: UsageProxyOptions = {},
): Promise<Response> {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
    throw new Error(`Unsupported proxy protocol ${proxy.protocol}`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`Unsupported target ${target.protocol}`);
  }

  const proxyTimeout = options.proxyAttemptTimeoutMs ?? DEFAULT_PROXY_ATTEMPT_TIMEOUT_MS;
  const signals = [AbortSignal.timeout(proxyTimeout)];
  if (init.signal instanceof AbortSignal) signals.unshift(init.signal);
  const signal = combineSignals(signals)!;
  if (signal.aborted) throw abortError(signal);

  const body = await serializeBody(init.body);
  if (target.protocol === "https:") {
    return requestHttpsTargetThroughProxy(target, proxy, init, body, signal);
  }
  return requestHttpTargetThroughProxy(target, proxy, init, body, signal);
}

async function initFromRequest(input: Request, init: RequestInit): Promise<RequestInit> {
  const headers = new Headers(input.headers);
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  const signals: AbortSignal[] = [];
  if (input.signal) signals.push(input.signal);
  if (init.signal instanceof AbortSignal) signals.push(init.signal);
  const method = (init.method ?? input.method).toUpperCase();
  return {
    ...init,
    method,
    headers,
    body:
      init.body ??
      (method === "GET" || method === "HEAD" || input.bodyUsed ? undefined : await input.arrayBuffer()),
    signal: combineSignals(signals),
  };
}

function callerAborted(input: string | URL | Request, init: RequestInit): boolean {
  if (init.signal instanceof AbortSignal && init.signal.aborted) return true;
  return input instanceof Request && input.signal.aborted;
}

function fetchDirect(target: URL, requestInit: RequestInit, options: UsageProxyOptions): Promise<Response> {
  if (requestInit.signal) return fetch(target, requestInit);
  return fetch(target, {
    ...requestInit,
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_PROXY_REQUEST_TIMEOUT_MS),
  });
}

/**
 * Drop-in fetch replacement for usage traffic. Explicit proxy env vars win,
 * otherwise a loopback proxy is probed. Proxy transport failures retry direct.
 */
export async function fetchWithAutoProxy(
  input: string | URL | Request,
  init: RequestInit = {},
  options: UsageProxyOptions = {},
): Promise<Response> {
  const env = options.env ?? process.env;
  const proxyUrl = await resolveUsageProxyUrl({ ...options, env });
  if (!proxyUrl) return fetch(input, init);

  let target: URL;
  try {
    target = new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    return fetch(input, init);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return fetch(input, init);
  if (isProxyBypassed(target, env)) return fetch(input, init);

  const requestInit = input instanceof Request ? await initFromRequest(input, init) : { ...init };
  try {
    return await requestThroughProxy(target, proxyUrl, requestInit, { ...options, env });
  } catch (error) {
    if (callerAborted(input, init)) throw error;
    console.warn(
      `Usage proxy ${redactedProxyUrl(proxyUrl)} failed, retrying direct: ${(error as Error).message}`,
    );
    return fetchDirect(target, requestInit, options);
  }
}
