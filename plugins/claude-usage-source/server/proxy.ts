import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { z } from "zod";
import { readJson } from "./stores.js";

/** The subset of `fetch` the Claude usage source calls. */
export type ClaudeFetch = (url: string, init?: RequestInit) => Promise<Response>;

// Claude Code applies `env` from its settings.json to its own process, so a user who
// configures a proxy there expects Claude's own endpoints to use it. Only the Claude
// account requests follow it; every other daemon request keeps the daemon's policy.
const ClaudeSettingsSchema = z.object({ env: z.record(z.string(), z.unknown()).optional() });

// The usage endpoints are HTTPS, so the HTTPS variables win; lowercase wins over uppercase,
// matching the daemon's own proxy policy (packages/server/src/server/network/index.ts).
const PROXY_VARIABLES = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;
const NO_PROXY_VARIABLES = ["no_proxy", "NO_PROXY"] as const;

export const CLAUDE_API_HOST = "api.anthropic.com";

/** The proxy Claude Code's settings.json configures for `host`, or null to use the daemon's policy. */
export async function readClaudeSettingsProxy(
  settingsPath: string,
  host: string = CLAUDE_API_HOST,
): Promise<URL | null> {
  const settings = ClaudeSettingsSchema.safeParse(await readJson(settingsPath));
  const env = settings.success ? settings.data.env : undefined;
  if (!env) return null;
  function value(name: string): string | undefined {
    const raw = env?.[name];
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  }
  const noProxy = NO_PROXY_VARIABLES.map(value).find((entry) => entry !== undefined);
  if (noProxy && bypasses(noProxy, host, 443)) return null;
  for (const name of PROXY_VARIABLES) {
    const raw = value(name);
    if (!raw) continue;
    const proxy = parseProxy(raw);
    if (proxy) return proxy;
    // Never log the value: proxy URLs carry credentials.
    console.warn({ settingsPath, variable: name }, "Ignoring unsupported Claude settings proxy");
  }
  return null;
}

function parseProxy(raw: string): URL | null {
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url;
  } catch {
    return null;
  }
}

function bypasses(noProxy: string, host: string, port: number): boolean {
  return noProxy
    .toLowerCase()
    .split(/[,\s]+/)
    .some((entry) => {
      if (entry === "*") return true;
      const match = entry.match(/^(.+):(\d+)$/);
      if (match && Number(match[2]) !== port) return false;
      const suffix = (match ? match[1]! : entry).replace(/^\*?\./, "");
      return suffix !== "" && (host === suffix || host.endsWith(`.${suffix}`));
    });
}

/** Fetch for a login whose Claude settings.json may configure a proxy. */
export async function claudeSettingsFetch(
  settingsPath: string | undefined,
  fallback: ClaudeFetch = fetch,
): Promise<ClaudeFetch> {
  const proxy = settingsPath ? await readClaudeSettingsProxy(settingsPath) : null;
  return proxy ? createProxyFetch(proxy) : fallback;
}

type SecureTunnel = (tunnel: Duplex, servername: string) => Duplex;

const secureTunnel: SecureTunnel = (tunnel, servername) =>
  tlsConnect({ socket: tunnel, servername });

/**
 * A GET-only fetch that reaches HTTPS origins through an HTTP CONNECT proxy.
 *
 * Built-in plugins bundle only the SDK, zod and Node built-ins, so this uses `node:http`
 * instead of an undici dispatcher. `secure` exists for tests that cannot present a
 * trusted certificate for the origin.
 */
export function createProxyFetch(proxy: URL, secure: SecureTunnel = secureTunnel): ClaudeFetch {
  return async (url, init = {}) => {
    const target = new URL(url);
    if (target.protocol !== "https:") throw new Error("Claude proxy fetch supports HTTPS only");
    if ((init.method ?? "GET") !== "GET" || init.body != null)
      throw new Error("Claude proxy fetch supports GET only");
    const signal = init.signal ?? undefined;
    signal?.throwIfAborted();
    const tunnel = await openTunnel(proxy, target, signal);
    return send(secure(tunnel, target.hostname), target, new Headers(init.headers), signal);
  };
}

function openTunnel(proxy: URL, target: URL, signal: AbortSignal | undefined): Promise<Duplex> {
  const authority = `${target.hostname}:${target.port || "443"}`;
  const headers: OutgoingHttpHeaders = { host: authority };
  if (proxy.username || proxy.password) {
    const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
    headers["proxy-authorization"] = `Basic ${Buffer.from(credentials).toString("base64")}`;
  }
  const request = proxy.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const connect = request({
      host: proxy.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: proxy.port || undefined,
      method: "CONNECT",
      path: authority,
      headers,
      agent: false,
      signal,
    });
    connect.once("connect", (response, socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
        return;
      }
      socket.destroy();
      // proxy.host omits credentials.
      reject(new Error(`Proxy ${proxy.host} refused ${authority}: HTTP ${response.statusCode}`));
    });
    connect.once("error", (error) => reject(abortReason(signal) ?? error));
    connect.end();
  });
}

function send(
  socket: Duplex,
  target: URL,
  headers: Headers,
  signal: AbortSignal | undefined,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: { ...Object.fromEntries(headers), host: target.host, connection: "close" },
        createConnection: () => socket,
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", (error) => reject(abortReason(signal) ?? error));
        response.once("end", () => {
          socket.destroy();
          resolve(toResponse(response, Buffer.concat(chunks)));
        });
      },
    );
    request.once("error", (error) => {
      socket.destroy();
      reject(abortReason(signal) ?? error);
    });
    request.end();
  });
}

// Node's http reports a generic AbortError; fetch rejects with the signal's reason.
function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.aborted ? signal.reason : undefined;
}

function toResponse(response: IncomingMessage, body: Buffer): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  const status = response.statusCode ?? 502;
  const empty = status === 204 || status === 205 || status === 304;
  return new Response(empty ? null : new Uint8Array(body), {
    status,
    statusText: response.statusMessage,
    headers,
  });
}
