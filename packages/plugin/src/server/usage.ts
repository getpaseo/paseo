import { createHash } from "node:crypto";
import { connect as tcpConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { z, type ZodType } from "zod";
import type { JsonValue } from "@getpaseo/protocol/agent-types";

export interface UsageWindow {
  id: string;
  label: string;
  /**
   * A few characters naming the window where space is tight, e.g. "5h" or "wk". An empty string
   * shows the percent alone; leaving it out shows `label`.
   */
  shortLabel?: string;
  /** Shown in the usage summary until the user pins windows of their own. */
  summary?: boolean;
  usedPct?: number | null;
  remainingPct?: number | null;
  resetsAt?: string | null;
  runsOutAt?: string | null;
  shortfallPct?: number | null;
  tone?: "default" | "ok" | "warning" | "danger";
}

export interface UsageBalance {
  id: string;
  label: string;
  used?: number | null;
  remaining?: number | null;
  limit?: number | null;
  unit: "usd" | "credits" | "requests" | "tokens";
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}

export interface UsageDetail {
  id: string;
  label: string;
  value: string;
  tone?: UsageWindow["tone"];
}

export type UsageProblem =
  | { kind: "expired"; expiresAt: string; refreshedBy?: string }
  | { kind: "rejected"; status: number; refreshedBy?: string }
  | { kind: "no_quota"; detail: string };

export type UsageReport =
  | {
      status: "available";
      planLabel?: string;
      windows: UsageWindow[];
      balances?: UsageBalance[];
      details?: UsageDetail[];
    }
  | { status: "unavailable"; problem: UsageProblem }
  | { status: "error"; error: string };

export interface UsageAccount {
  /** Stable across token rotation; [A-Za-z0-9._-]{1,128}. Never a credential or raw email. */
  key: string;
  label?: string;
  /** Harness owning this login, e.g. Codex, OpenCode, Pi or OMP. */
  harness?: string;
  /** Store locator, opaque to the daemon. */
  input: JsonValue;
}

export const UsageScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({
    kind: z.literal("session"),
    provider: z.string(),
    model: z.string().optional(),
    env: z.record(z.string(), z.string()),
  }),
]);
export type UsageScope = z.infer<typeof UsageScopeSchema>;

export interface UsageSourceRegistration {
  id: string;
  label: string;
  icon?: string;
  input: ZodType;
  /** Accounts for this scope only. The same key in any scope identifies the same account. */
  discover(scope: UsageScope): Promise<UsageAccount[]>;
  /** Re-reads the login store; never writes it. */
  fetch(input: unknown): Promise<UsageReport>;
}

export function windowFromUsedPct(input: {
  id: string;
  label: string;
  shortLabel?: string;
  summary?: boolean;
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const usedPct = typeof input.utilizationPct === "number" ? input.utilizationPct : null;
  const window: UsageWindow = {
    id: input.id,
    label: input.label,
    usedPct,
    remainingPct: usedPct === null ? null : Math.max(0, 100 - usedPct),
    resetsAt: input.resetsAt ?? null,
  };
  if (input.shortLabel !== undefined) window.shortLabel = input.shortLabel;
  if (input.summary) window.summary = true;
  if (input.tone) window.tone = input.tone;
  return window;
}

/**
 * Numeric provider windows have one identity and vocabulary, independent of response slots.
 * Pass null when the provider omits the duration; reset countdowns are not window lengths.
 * Named API fields (weekly, monthly, etc.) use windowFromUsedPct instead.
 */
export function windowFromReportedDuration(input: {
  durationSeconds: number | null;
  /** Stable quota identity and provider name for a model- or feature-scoped limit. */
  scope?: { id: string; label: string };
  /** Neutral identity and names when the provider does not report a positive duration. */
  unknown: { id: string; label: string; shortLabel: string };
  utilizationPct: number | null | undefined;
  resetsAt?: string | null;
  summary?: boolean;
  tone?: UsageWindow["tone"];
}): UsageWindow {
  const duration = input.durationSeconds;
  const name =
    duration !== null && Number.isFinite(duration) && duration > 0
      ? durationWindowName(duration)
      : input.unknown;
  const scope = input.scope;
  return windowFromUsedPct({
    id: scope ? `${scope.id}:${name.id}` : name.id,
    label: scope ? `${scope.label} · ${name.label}` : name.label,
    shortLabel: scope
      ? `${scope.label}${name.shortLabel ? ` ${name.shortLabel}` : ""}`
      : name.shortLabel,
    utilizationPct: input.utilizationPct,
    resetsAt: input.resetsAt,
    summary: input.summary,
    tone: input.tone,
  });
}

function durationWindowName(seconds: number): { id: string; label: string; shortLabel: string } {
  if (seconds === 604800) return { id: "weekly", label: "Weekly", shortLabel: "wk" };
  const id = seconds === 18000 ? "five_hour" : `${seconds}s`;
  const units = [
    [86400, "day", "d"],
    [3600, "hour", "h"],
    [60, "minute", "m"],
    [1, "second", "s"],
  ] as const;
  const unit = units.find(([size]) => seconds % size === 0) ?? units[units.length - 1]!;
  const amount = seconds / unit[0];
  return { id, label: `${amount}-${unit[1]}`, shortLabel: `${amount}${unit[2]}` };
}

/**
 * The tone scale for anything measured against a known limit, windows and balances alike.
 *
 * Thresholds match `deriveTone` in the app's provider-usage/tone.ts, which is what the
 * client falls back to when a window arrives without a tone. Healthy is "ok" rather than
 * "default" because that is what every provider setting a tone has always sent, and it is
 * what the bars render today below their thresholds.
 */
export function toneFromUsedPct(usedPct: number | null | undefined): UsageWindow["tone"] {
  if (typeof usedPct !== "number") return "default";
  if (usedPct > 90) return "danger";
  if (usedPct >= 70) return "warning";
  return "ok";
}

/**
 * Tone for a balance with no known limit, where a percentage cannot be computed and the
 * only signal is whether anything is left. Prefer `toneFromUsedPct` when a limit exists:
 * this one stays "ok" until the balance is completely spent.
 */
export function balanceToneFromRemaining(
  remaining: number | null | undefined,
): UsageBalance["tone"] {
  if (typeof remaining !== "number") return "default";
  if (remaining <= 0) return "danger";
  return "ok";
}

/** Percentage of a limit consumed, or null when either side is unknown. */
export function usedPctOf(
  used: number | null | undefined,
  limit: number | null | undefined,
): number | null {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) return null;
  return (used / limit) * 100;
}

export function hashAccountKey(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function unavailable(problem: UsageProblem): UsageReport {
  return { status: "unavailable", problem };
}

// ---------------------------------------------------------------------------
// Outbound HTTP proxy for vendor usage endpoints.
//
// Claude (`api.anthropic.com`) and Codex (`chatgpt.com`) usage calls go through
// the global fetch, which never consults proxy settings. Where that traffic is
// blocked, usage silently goes dark. These helpers route the two usage sources
// through a proxy instead:
//
// 1. An explicit `HTTPS_PROXY`/`https_proxy` (falling back to `HTTP_PROXY`/
//    `http_proxy`) wins when set, honouring `NO_PROXY`/`no_proxy`.
// 2. Otherwise the loopback proxy port 7890 (Clash and friends) is probed with
//    a short TCP handshake; when something answers, it is used automatically.
// 3. When the proxy attempt fails at the transport level, the request falls
//    back to a direct fetch so a broken proxy cannot take usage offline.
//
// Only `http:`/`https:` proxies are supported. The proxied request is plain
// HTTP/1.1 with `Connection: close` and no redirect following; vendor usage
// endpoints need neither.
// ---------------------------------------------------------------------------

export interface UsageProxyOptions {
  /** Defaults to `process.env`. Override in tests. */
  env?: NodeJS.ProcessEnv;
  /** Loopback host probed when no proxy env var is set. Defaults to "127.0.0.1". */
  probeHost?: string;
  /** Loopback port probed when no proxy env var is set. Defaults to 7890. */
  probePort?: number;
  /** TCP probe timeout in milliseconds. Defaults to 500. */
  probeTimeoutMs?: number;
  /** Fallback timeout for a proxied request without its own signal. Defaults to 15_000. */
  requestTimeoutMs?: number;
}

const DEFAULT_PROXY_PROBE_HOST = "127.0.0.1";
const DEFAULT_PROXY_PROBE_PORT = 7890;
const DEFAULT_PROXY_PROBE_TIMEOUT_MS = 500;
const DEFAULT_PROXY_REQUEST_TIMEOUT_MS = 15_000;
const MAX_PROXY_BODY_BYTES = 10 * 1024 * 1024;
const MAX_PROXY_HEAD_BYTES = 8 * 1024;

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

/** Whether `hostname` is excluded from proxying by `NO_PROXY`/`no_proxy`. */
export function isProxyBypassed(hostname: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["NO_PROXY"] ?? env["no_proxy"];
  if (!raw) return false;
  const host = hostname.toLowerCase();
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .some((entry) => {
      if (entry === "*") return true;
      const name = (entry.startsWith(".") ? entry.slice(1) : entry).split(":")[0]!;
      return host === name || host.endsWith(`.${name}`);
    });
}

function isTcpPortOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolve(open);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
    socket.setTimeout(timeoutMs);
  });
}

/**
 * Resolve the proxy URL for usage traffic, or null when requests should go
 * direct. Explicit env vars win; otherwise a loopback proxy is auto-detected.
 */
export async function resolveUsageProxyUrl(
  options: UsageProxyOptions = {},
): Promise<string | null> {
  const env = options.env ?? process.env;
  const fromEnv = proxyEnv(env);
  if (fromEnv) return normalizeProxyUrl(fromEnv);
  const host = options.probeHost ?? DEFAULT_PROXY_PROBE_HOST;
  const port = options.probePort ?? DEFAULT_PROXY_PROBE_PORT;
  if (await isTcpPortOpen(host, port, options.probeTimeoutMs ?? DEFAULT_PROXY_PROBE_TIMEOUT_MS)) {
    return new URL(`http://${host}:${port}`).toString();
  }
  return null;
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("This operation was aborted", "AbortError");
}

function connectTcp(
  host: string,
  port: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const socket = tcpConnect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy connection to ${host}:${port} timed out`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      socket.destroy();
      cleanup();
      reject(abortError(signal));
    };
    socket.once("connect", () => {
      cleanup();
      resolve(socket);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read from `socket` until `marker` appears. Rejects past `limit` bytes. */
function readUntilMarker(
  socket: Socket,
  marker: string,
  limit: number,
  signal: AbortSignal,
  stash: Buffer[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    let buffered = Buffer.concat(stash);
    stash.length = 0;
    const markerBytes = Buffer.from(marker);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const at = buffered.indexOf(markerBytes);
      if (at !== -1) {
        if (at > limit) {
          cleanup();
          reject(new Error("Proxy response head exceeds limit"));
          return;
        }
        stash.push(buffered.subarray(at + markerBytes.length));
        cleanup();
        resolve(buffered.subarray(0, at).toString("latin1"));
        return;
      }
      // The limit bounds the head, not the buffer: stash may already hold body
      // bytes past the marker, and a marker beginning in the last
      // markerBytes.length - 1 bytes is an incomplete tail match, not an overflow.
      if (buffered.length - markerBytes.length + 1 > limit) {
        cleanup();
        reject(new Error("Proxy response head exceeds limit"));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Proxy connection closed"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    // The head may already be fully buffered (e.g. a stub that answered eagerly).
    onData(Buffer.alloc(0));
  });
}

interface ProxyResponseHead {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

function parseResponseHead(head: string): ProxyResponseHead {
  const [statusLine, ...headerLines] = head.split("\r\n");
  const match = (statusLine ?? "").match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/);
  if (!match) throw new Error("Proxy returned a malformed response");
  const headers: Array<[string, string]> = [];
  for (const line of headerLines) {
    if (!line.trim()) continue;
    const at = line.indexOf(":");
    if (at === -1) throw new Error("Proxy returned a malformed header");
    headers.push([line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()]);
  }
  return { status: Number(match[1]), statusText: (match[2] ?? "").trim(), headers };
}

function headerValue(headers: Array<[string, string]>, name: string): string | null {
  const found = headers.filter(([key]) => key === name).map(([, value]) => value);
  return found.length === 0 ? null : found.join(", ");
}

function readExact(
  socket: Socket,
  stash: Buffer[],
  length: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    let buffered = Buffer.concat(stash);
    stash.length = 0;
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length >= length) {
        stash.push(buffered.subarray(length));
        cleanup();
        resolve(buffered.subarray(0, length));
        return;
      }
      if (buffered.length > MAX_PROXY_BODY_BYTES) {
        cleanup();
        reject(new Error("Proxy response body exceeds limit"));
      }
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Proxy connection closed mid-body"));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal.addEventListener("abort", onAbort, { once: true });
    onData(Buffer.alloc(0));
  });
}

function readToClose(socket: Socket, stash: Buffer[], signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const parts = stash.splice(0);
    let size = parts.reduce((total, part) => total + part.length, 0);
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      socket.removeListener("end", onEnd);
      signal.removeEventListener("abort", onAbort);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_PROXY_BODY_BYTES) {
        socket.destroy();
        cleanup();
        reject(new Error("Proxy response body exceeds limit"));
        return;
      }
      parts.push(chunk);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Proxy connection closed mid-body"));
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(parts));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    socket.once("end", onEnd);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readChunkedBody(
  socket: Socket,
  stash: Buffer[],
  signal: AbortSignal,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (;;) {
    const line = (await readUntilMarker(socket, "\r\n", 256, signal, stash)).split(";")[0]!.trim();
    const size = Number.parseInt(line, 16);
    if (!Number.isFinite(size) || size < 0) throw new Error("Proxy returned bad chunk size");
    if (size === 0) {
      await readTrailers(socket, stash, signal);
      return Buffer.concat(chunks);
    }
    chunks.push(await readExact(socket, stash, size, signal));
    await readUntilMarker(socket, "\r\n", 8, signal, stash);
  }
}

async function readTrailers(socket: Socket, stash: Buffer[], signal: AbortSignal): Promise<void> {
  // After the last-chunk line, the trailer section runs to the first empty
  // line. Trailer fields carry no meaning for usage polling and are dropped.
  for (;;) {
    const line = await readUntilMarker(socket, "\r\n", MAX_PROXY_HEAD_BYTES, signal, stash);
    if (line === "") return;
  }
}

async function readResponseBody(
  socket: Socket,
  stash: Buffer[],
  method: string,
  status: number,
  headers: Array<[string, string]>,
  signal: AbortSignal,
): Promise<Buffer> {
  if (method === "HEAD" || status === 204 || status === 304) return Buffer.alloc(0);
  const transferEncoding = headerValue(headers, "transfer-encoding")?.toLowerCase() ?? "";
  if (transferEncoding.includes("chunked")) return readChunkedBody(socket, stash, signal);
  const contentLength = headerValue(headers, "content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (!Number.isInteger(length) || length < 0) throw new Error("Proxy returned bad length");
    if (length === 0) return Buffer.alloc(0);
    return readExact(socket, stash, length, signal);
  }
  return readToClose(socket, stash, signal);
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

function writeSocket(socket: Socket, chunk: Uint8Array | string): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(chunk, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Perform one HTTP/1.1 exchange over `socket` and return a real Response.
 * Redirects are not followed; usage endpoints do not use them.
 */
async function exchangeOverSocket(
  socket: Socket,
  method: string,
  path: string,
  headers: Headers,
  body: Uint8Array | null,
  signal: AbortSignal,
): Promise<Response> {
  headers.set("Connection", "close");
  headers.delete("transfer-encoding");
  if (body && !headers.has("content-length")) headers.set("content-length", String(body.length));
  let head = `${method} ${path} HTTP/1.1\r\n`;
  headers.forEach((value, name) => {
    head += `${name}: ${value}\r\n`;
  });
  await writeSocket(socket, head + "\r\n");
  if (body) await writeSocket(socket, body);
  const stash: Buffer[] = [];
  let parsed = parseResponseHead(
    await readUntilMarker(socket, "\r\n\r\n", MAX_PROXY_HEAD_BYTES, signal, stash),
  );
  // Skip 1xx interim responses (never 101 here: no upgrade is requested).
  while (parsed.status >= 100 && parsed.status < 200) {
    parsed = parseResponseHead(
      await readUntilMarker(socket, "\r\n\r\n", MAX_PROXY_HEAD_BYTES, signal, stash),
    );
  }
  const responseBody = await readResponseBody(
    socket,
    stash,
    method,
    parsed.status,
    parsed.headers,
    signal,
  );
  const responseHeaders = new Headers();
  for (const [name, value] of parsed.headers) responseHeaders.append(name, value);
  return new Response(new Uint8Array(responseBody), {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: responseHeaders,
  });
}

/** Rejects with `message` after `ms`. The timer never keeps the process alive. */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms).unref();
  });
}

async function performConnect(
  socket: Socket,
  authority: string,
  proxyAuthorization: string | null,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  let head = `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n`;
  if (proxyAuthorization) head += `Proxy-Authorization: ${proxyAuthorization}\r\n`;
  await writeSocket(socket, `${head}\r\n`);
  const parsed = parseResponseHead(
    await Promise.race([
      readUntilMarker(socket, "\r\n\r\n", MAX_PROXY_HEAD_BYTES, signal, []),
      rejectAfter(timeoutMs, "Proxy CONNECT timed out"),
    ]),
  );
  if (parsed.status < 200 || parsed.status >= 300) {
    throw new Error(`Proxy CONNECT to ${authority} rejected with status ${parsed.status}`);
  }
}

function secureOverSocket(
  socket: Socket,
  servername: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const secure = tlsConnect({ socket, servername, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new Error("Proxy TLS handshake timed out"));
    }, timeoutMs);
    const onAbort = () => {
      secure.destroy();
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      clearTimeout(timer);
      secure.removeAllListeners();
      signal.removeEventListener("abort", onAbort);
    };
    secure.once("secureConnect", () => {
      cleanup();
      resolve(secure as unknown as Socket);
    });
    secure.once("error", (error) => {
      cleanup();
      reject(error);
    });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function proxyAuthorizationValue(proxy: URL): string | null {
  if (!proxy.username) return null;
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

/**
 * Route one request through an `http:` proxy URL. Throws on proxy transport
 * failures; HTTP responses from the origin (including errors) are returned.
 */
export async function requestThroughProxy(
  target: URL,
  proxyUrl: string,
  init: RequestInit = {},
  options: UsageProxyOptions = {},
): Promise<Response> {
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "http:") {
    throw new Error(`Unsupported proxy protocol ${proxy.protocol}`);
  }
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_PROXY_REQUEST_TIMEOUT_MS;
  const callerSignals: AbortSignal[] = [];
  if (init.signal instanceof AbortSignal) callerSignals.push(init.signal);
  const signal =
    callerSignals.length === 0 ? AbortSignal.timeout(timeoutMs) : combineSignals(callerSignals)!;
  if (signal.aborted) throw abortError(signal);

  const headers = new Headers();
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  headers.set("Host", target.host);
  const proxyAuthorization = proxyAuthorizationValue(proxy);
  if (proxyAuthorization) headers.set("Proxy-Authorization", proxyAuthorization);
  const body = await serializeBody(init.body);
  const method = (init.method ?? "GET").toUpperCase();

  const proxyPort = proxy.port ? Number(proxy.port) : 80;
  const socket = await connectTcp(proxy.hostname, proxyPort, timeoutMs, signal);
  try {
    if (target.protocol === "https:") {
      const authority = `${target.hostname}:${target.port ? Number(target.port) : 443}`;
      await performConnect(socket, authority, proxyAuthorization, timeoutMs, signal);
      const secure = await secureOverSocket(socket, target.hostname, timeoutMs, signal);
      try {
        return await exchangeOverSocket(
          secure,
          method,
          `${target.pathname}${target.search}` || "/",
          headers,
          body,
          signal,
        );
      } finally {
        secure.destroy();
      }
    }
    if (target.protocol !== "http:") throw new Error(`Unsupported target ${target.protocol}`);
    return await exchangeOverSocket(socket, method, target.toString(), headers, body, signal);
  } finally {
    socket.destroy();
  }
}

/**
 * One signal from many: the first to abort wins. With no signals, `fallback`
 * applies; an absent fallback means never abort.
 */
function combineSignals(signals: AbortSignal[], fallback?: AbortSignal): AbortSignal | undefined {
  if (signals.length === 0) return fallback;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * Fold a Request input's method, headers, body, and signal under `init`'s
 * explicit overrides, so a proxied call sees the same request fetch would.
 */
async function initFromRequest(input: Request, init: RequestInit): Promise<RequestInit> {
  const headers = new Headers(input.headers);
  if (init.headers) {
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  }
  const signals: AbortSignal[] = [];
  if (input.signal) signals.push(input.signal);
  if (init.signal instanceof AbortSignal) signals.push(init.signal);
  return {
    ...init,
    method: init.method ?? input.method,
    headers,
    body: init.body ?? (input.bodyUsed ? undefined : await input.arrayBuffer()),
    signal: combineSignals(signals),
  };
}

/**
 * Direct fetch honoring the caller's signal, or a request timeout when the
 * caller did not provide one.
 */
function fetchDirect(
  input: string | URL | Request,
  init: RequestInit,
  requestInit: RequestInit,
  options: UsageProxyOptions,
): Promise<Response> {
  if (requestInit.signal || init.signal) return fetch(input, init);
  return fetch(input, {
    ...init,
    signal: AbortSignal.timeout(options.requestTimeoutMs ?? DEFAULT_PROXY_REQUEST_TIMEOUT_MS),
  });
}

/**
 * Drop-in `fetch` replacement for usage traffic. Resolves the proxy (explicit
 * env vars, else an auto-detected loopback proxy), uses it unless `NO_PROXY`
 * excludes the target, and falls back to a direct fetch when the proxy attempt
 * fails so a broken proxy cannot take usage offline.
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
  if (isProxyBypassed(target.hostname, env)) return fetch(input, init);
  const requestInit = input instanceof Request ? await initFromRequest(input, init) : init;
  try {
    return await requestThroughProxy(target, proxyUrl, requestInit, { ...options, env });
  } catch (error) {
    if (init.signal instanceof AbortSignal && init.signal.aborted) throw error;
    if (input instanceof Request && input.signal.aborted) throw error;
    console.warn(`Usage proxy ${proxyUrl} failed, retrying direct: ${(error as Error).message}`);
    return fetchDirect(input, init, requestInit, options);
  }
}
