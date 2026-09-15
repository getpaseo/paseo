import { waitForDaemonReady, resolvePaseoHome, type DaemonInstance } from "@getpaseo/server";
import { describeDaemonTarget, type DaemonTarget } from "./daemon-target.js";
export type { DaemonTarget } from "./daemon-target.js";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import {
  parseConnectionOfferFromUrl,
  type ConnectionOffer,
} from "@getpaseo/protocol/connection-offer";
import { parseSshTransportUri } from "@getpaseo/protocol/ssh-transport";
import { DaemonClient, type WebSocketLike } from "@getpaseo/client/internal/daemon-client";
import { WebSocket } from "ws";
import { getOrCreateCliClientId } from "./client-id.js";
import { resolveCliVersion } from "../version.js";
import { createSshTunnel } from "../ssh/ssh-tunnel.js";

export interface ConnectOptions {
  target: DaemonTarget;
  timeout?: number;
  instance?: DaemonInstance;
}
const DEFAULT_TIMEOUT = 15000;
type TransportTarget =
  | { type: "tcp"; url: string }
  | { type: "ipc"; url: string; socketPath: string };

export function getDaemonHost(options: ConnectOptions): string {
  return describeDaemonTarget(options.target);
}

export function buildDaemonConnectionCommandError(options: ConnectOptions & { error: unknown }) {
  const error = options.error;
  let message = error instanceof Error ? error.message : String(error);
  if (error && typeof error === "object" && "message" in error) message = String(error.message);
  if (options.target.kind === "endpoint")
    message = message.replaceAll(options.target.host, describeDaemonTarget(options.target));
  if (message.startsWith("Cannot connect to daemon at "))
    return error as { code: string; message: string; details: string };
  let code = "DAEMON_UNREACHABLE";
  if (typeof error === "object" && error !== null && "code" in error) code = String(error.code);
  else if (message === "Password required") code = "AUTH_REQUIRED";
  else if (message === "Incorrect password") code = "AUTH_FAILED";
  return {
    code,
    message: `Cannot connect to daemon at ${describeDaemonTarget(options.target)}: ${message}`,
    details:
      options.target.kind === "instance"
        ? `Start with: paseo daemon start --home ${JSON.stringify(options.target.home)}`
        : "Check the selected endpoint and credentials. SSH transport does not install or start the daemon.",
  };
}

export function normalizeDaemonHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("tcp://")) {
    try {
      const parsed = parseConnectionUri(trimmed);
      const endpoint = normalizeHostPort(
        parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
      );
      const query = new URLSearchParams();
      if (parsed.useTls) {
        query.set("ssl", "true");
      }
      if (parsed.password) {
        query.set("password", parsed.password);
      }
      const queryString = query.toString();
      const suffix = queryString ? `?${queryString}` : "";
      return `tcp://${endpoint}${suffix}`;
    } catch {
      return null;
    }
  }

  if (
    trimmed.startsWith("unix://") ||
    trimmed.startsWith("pipe://") ||
    trimmed.startsWith("\\\\.\\pipe\\")
  ) {
    return trimmed.startsWith("\\\\.\\pipe\\") ? `pipe://${trimmed}` : trimmed;
  }

  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    return `unix://${trimmed}`;
  }

  // Windows absolute paths (e.g. C:\Users\foo) are filesystem paths, not TCP or IPC targets.
  if (/^[A-Za-z]:[/\\]/.test(trimmed)) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    return `127.0.0.1:${trimmed}`;
  }

  return trimmed.includes(":") ? trimmed : null;
}

function stripIpcPrefix(trimmed: string): string {
  if (trimmed.startsWith("unix://")) return trimmed.slice("unix://".length).trim();
  if (trimmed.startsWith("pipe://")) return trimmed.slice("pipe://".length).trim();
  return trimmed;
}

export function resolveDaemonTarget(host: string): TransportTarget {
  const trimmed = normalizeDaemonHost(host);
  if (!trimmed) {
    throw new Error(`Invalid daemon target: ${host}`);
  }
  if (
    trimmed.startsWith("unix://") ||
    trimmed.startsWith("pipe://") ||
    trimmed.startsWith("\\\\.\\pipe\\")
  ) {
    const socketPath = stripIpcPrefix(trimmed);
    if (!socketPath) {
      throw new Error("Invalid IPC daemon target: missing socket path");
    }
    const isUnixSocket = trimmed.startsWith("unix://");
    return {
      type: "ipc",
      url: isUnixSocket ? `ws+unix://${socketPath}:/ws` : "ws://localhost/ws",
      socketPath,
    };
  }

  if (trimmed.startsWith("tcp://")) {
    const parsed = parseConnectionUri(trimmed);
    const endpoint = normalizeHostPort(
      parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
    );
    return {
      type: "tcp",
      url: buildDaemonWebSocketUrl(endpoint, { useTls: parsed.useTls }),
    };
  }

  return {
    type: "tcp",
    url: `ws://${trimmed}/ws`,
  };
}

export function resolveDaemonPassword(host: string): string | undefined {
  const trimmed = host.trim();
  if (trimmed.startsWith("tcp://")) {
    const fromUri = parseConnectionUri(trimmed).password;
    if (fromUri) return fromUri;
  }
  const fromEnv = process.env.PASEO_PASSWORD;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Create a WebSocket factory that works in Node.js
 */
function createNodeWebSocketFactory() {
  return (
    url: string,
    options?: { headers?: Record<string, string>; protocols?: string[]; socketPath?: string },
  ): WebSocketLike => {
    return new WebSocket(url, options?.protocols, {
      headers: options?.headers,
      ...(options?.socketPath ? { socketPath: options.socketPath } : {}),
    }) as unknown as WebSocketLike;
  };
}

/**
 * Create and connect a daemon client
 * Returns the connected client or throws if connection fails
 */
async function tryConnectHost(
  host: string,
  password: string | undefined,
  clientId: string,
  timeout: number,
  nodeWebSocketFactory: ReturnType<typeof createNodeWebSocketFactory>,
): Promise<{ client: DaemonClient } | { error: unknown }> {
  const target = resolveDaemonTarget(host);
  const client = new DaemonClient({
    url: target.url,
    clientId,
    clientType: "cli",
    appVersion: resolveCliVersion(),
    password,
    connectTimeoutMs: timeout,
    webSocketFactory: (
      url: string,
      config?: { headers?: Record<string, string>; protocols?: string[] },
    ) =>
      nodeWebSocketFactory(url, {
        headers: config?.headers,
        protocols: config?.protocols,
        ...(target.type === "ipc" ? { socketPath: target.socketPath } : {}),
      }),
    reconnect: { enabled: false },
  });

  try {
    await client.connect();
    return { client };
  } catch (error) {
    await client.close().catch(() => {});
    return { error };
  }
}

async function connectViaRelayOffer(
  offer: ConnectionOffer,
  clientId: string,
  timeout: number,
  nodeWebSocketFactory: ReturnType<typeof createNodeWebSocketFactory>,
): Promise<DaemonClient> {
  const url = buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint,
    serverId: offer.serverId,
    role: "client",
    useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
  });

  const client = new DaemonClient({
    url,
    clientId,
    clientType: "cli",
    appVersion: resolveCliVersion(),
    connectTimeoutMs: timeout,
    webSocketFactory: (
      target: string,
      config?: { headers?: Record<string, string>; protocols?: string[] },
    ) => nodeWebSocketFactory(target, { headers: config?.headers, protocols: config?.protocols }),
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });

  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => {});
    const message = error instanceof Error ? error.message : String(error);
    const lastError = client.lastError ? ` (${client.lastError})` : "";
    throw new Error(`Failed to connect via relay offer: ${message}${lastError}`, { cause: error });
  }
}

function parseHostOfferOrNull(host: string | undefined): ConnectionOffer | null {
  if (!host) return null;
  try {
    return parseConnectionOfferFromUrl(host);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid pairing offer URL: ${message}`, { cause: error });
  }
}

async function connectSelectedDaemon(options: ConnectOptions): Promise<DaemonClient> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const deadline = Date.now() + timeout;
  const explicitHost =
    options.target.kind === "endpoint"
      ? options.target.host
      : (
          await waitForDaemonReady(options.target.home, {
            timeoutMs: timeout,
            instance: options.instance,
          })
        ).listen;
  const clientId = await getOrCreateCliClientId(resolvePaseoHome({}));
  const nodeWebSocketFactory = createNodeWebSocketFactory();

  if (explicitHost?.trim().startsWith("ssh://")) {
    const target = parseSshTransportUri(explicitHost.trim());
    const tunnel = await createSshTunnel(target);
    const password = resolveDaemonPassword(explicitHost);
    const result = await tryConnectHost(
      tunnel.endpoint,
      password,
      clientId,
      Math.max(1, deadline - Date.now()),
      nodeWebSocketFactory,
    );
    if ("client" in result) {
      const close = result.client.close.bind(result.client);
      result.client.close = async () => {
        try {
          await close();
        } finally {
          tunnel.close();
        }
      };
      return result.client;
    }

    const failure = tunnel.failureDetail();
    tunnel.close();
    if (failure) throw new Error(`SSH connection failed: ${failure}`, { cause: result.error });
    throw result.error;
  }
  const offer = parseHostOfferOrNull(explicitHost);
  if (offer) {
    return connectViaRelayOffer(
      offer,
      clientId,
      Math.max(1, deadline - Date.now()),
      nodeWebSocketFactory,
    );
  }

  const result = await tryConnectHost(
    explicitHost,
    resolveDaemonPassword(explicitHost),
    clientId,
    Math.max(1, deadline - Date.now()),
    nodeWebSocketFactory,
  );
  if ("client" in result) return result.client;
  throw result.error;
}

export async function connectToDaemon(options: ConnectOptions): Promise<DaemonClient> {
  try {
    return await connectSelectedDaemon(options);
  } catch (error) {
    throw buildDaemonConnectionCommandError({ ...options, error });
  }
}

/**
 * Try to connect to the daemon, returns null if connection fails
 */
export async function tryConnectToDaemon(options: ConnectOptions): Promise<DaemonClient | null> {
  try {
    return await connectToDaemon(options);
  } catch {
    return null;
  }
}

/** Minimal agent type for ID resolution */
interface AgentLike {
  id: string;
  title?: string | null;
}

/**
 * Resolve an agent ID from a partial ID or name.
 * Supports:
 * - Full ID match
 * - Prefix match (first N characters)
 * - Title/name match (case-insensitive)
 *
 * Returns the full agent ID if found, null otherwise.
 */
export function resolveAgentId(idOrName: string, agents: AgentLike[]): string | null {
  if (!idOrName || agents.length === 0) {
    return null;
  }

  const query = idOrName.toLowerCase();

  // Try exact ID match first
  const exactMatch = agents.find((a) => a.id === idOrName);
  if (exactMatch) {
    return exactMatch.id;
  }

  // Try ID prefix match
  const prefixMatches = agents.filter((a) => a.id.toLowerCase().startsWith(query));
  if (prefixMatches.length === 1 && prefixMatches[0]) {
    return prefixMatches[0].id;
  }

  // Try title/name match (case-insensitive)
  const titleMatches = agents.filter((a) => a.title?.toLowerCase() === query);
  if (titleMatches.length === 1 && titleMatches[0]) {
    return titleMatches[0].id;
  }

  // Try partial title match
  const partialTitleMatches = agents.filter((a) => a.title?.toLowerCase().includes(query));
  if (partialTitleMatches.length === 1 && partialTitleMatches[0]) {
    return partialTitleMatches[0].id;
  }

  // If we have multiple prefix matches and no unique title match, return first prefix match
  const firstPrefixMatch = prefixMatches[0];
  if (firstPrefixMatch) {
    return firstPrefixMatch.id;
  }

  return null;
}
