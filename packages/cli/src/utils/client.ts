import { existsSync, readFileSync } from "node:fs";
import { loadConfig, resolvePaseoHome, DaemonClient } from "@getpaseo/server";
import path from "node:path";
import WebSocket from "ws";
import { getOrCreateCliClientId } from "./client-id.js";
import { resolveCliVersion } from "../version.js";

export interface ConnectOptions {
  host?: string;
  timeout?: number;
}

const DEFAULT_HOST = "localhost:6767";
const DEFAULT_TIMEOUT = 15000;
const PID_FILENAME = "paseo.pid";

type DaemonTarget =
  | {
      type: "tcp";
      url: string;
    }
  | {
      type: "ipc";
      url: string;
      socketPath: string;
    };

/**
 * Get the daemon host from environment or options
 */
export function getDaemonHost(options?: ConnectOptions): string {
  return resolveDaemonHostCandidates(options)[0] ?? DEFAULT_HOST;
}

export function normalizeDaemonHost(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
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

export function resolveDefaultDaemonHost(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDefaultDaemonHosts(env)[0] ?? DEFAULT_HOST;
}

function isIpcDaemonHost(host: string | null): host is string {
  return host !== null && (host.startsWith("unix://") || host.startsWith("pipe://"));
}

function isTcpDaemonHost(host: string | null): host is string {
  return host !== null && !isIpcDaemonHost(host);
}

function readPidSocketTarget(paseoHome: string): string | null {
  const pidPath = path.join(paseoHome, PID_FILENAME);
  if (!existsSync(pidPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(pidPath, "utf-8")) as {
      listen?: unknown;
      sockPath?: unknown;
    };
    return typeof parsed.listen === "string"
      ? parsed.listen
      : typeof parsed.sockPath === "string"
        ? parsed.sockPath
        : null;
  } catch {
    return null;
  }
}

function resolveConfiguredIpcDaemonHost(env: NodeJS.ProcessEnv, paseoHome: string): string | null {
  const directEnvHost = normalizeDaemonHost(env.PASEO_LISTEN ?? "");
  if (isIpcDaemonHost(directEnvHost)) {
    return directEnvHost;
  }

  const pidHost = normalizeDaemonHost(readPidSocketTarget(paseoHome) ?? "");
  if (isIpcDaemonHost(pidHost)) {
    return pidHost;
  }

  const config = loadConfig(paseoHome, { env });
  const configuredHost = normalizeDaemonHost(config.listen);
  return isIpcDaemonHost(configuredHost) ? configuredHost : null;
}

function resolveConfiguredTcpDaemonHost(env: NodeJS.ProcessEnv, paseoHome: string): string | null {
  const configuredHost = normalizeDaemonHost(loadConfig(paseoHome, { env }).listen);
  if (!isTcpDaemonHost(configuredHost)) {
    return null;
  }
  return configuredHost === "127.0.0.1:6767" ? null : configuredHost;
}

export function resolveDefaultDaemonHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const paseoHome = resolvePaseoHome(env);
  const candidates: string[] = [];
  const configuredIpcHost = resolveConfiguredIpcDaemonHost(env, paseoHome);
  if (configuredIpcHost) {
    candidates.push(configuredIpcHost);
  }
  const configuredTcpHost = resolveConfiguredTcpDaemonHost(env, paseoHome);
  if (configuredTcpHost) {
    candidates.push(configuredTcpHost);
  }
  candidates.push(DEFAULT_HOST);
  return Array.from(new Set(candidates));
}

function resolveDaemonHostCandidates(options?: ConnectOptions): string[] {
  const explicitHost = options?.host ?? process.env.PASEO_HOST;
  if (explicitHost) {
    return [explicitHost];
  }

  return resolveDefaultDaemonHosts();
}

export function resolveDaemonTarget(host: string): DaemonTarget {
  const trimmed = host.trim();
  if (
    trimmed.startsWith("unix://") ||
    trimmed.startsWith("pipe://") ||
    trimmed.startsWith("\\\\.\\pipe\\")
  ) {
    const socketPath = trimmed.startsWith("unix://")
      ? trimmed.slice("unix://".length).trim()
      : trimmed.startsWith("pipe://")
        ? trimmed.slice("pipe://".length).trim()
        : trimmed;
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

  return {
    type: "tcp",
    url: `ws://${trimmed}/ws`,
  };
}

/**
 * Create a WebSocket factory that works in Node.js
 */
function createNodeWebSocketFactory() {
  return (url: string, options?: { headers?: Record<string, string>; socketPath?: string }) => {
    return new WebSocket(url, {
      headers: options?.headers,
      ...(options?.socketPath ? { socketPath: options.socketPath } : {}),
    }) as unknown as {
      readyState: number;
      send: (data: string | Uint8Array | ArrayBuffer) => void;
      close: (code?: number, reason?: string) => void;
      binaryType?: string;
      on: (event: string, listener: (...args: unknown[]) => void) => void;
      off: (event: string, listener: (...args: unknown[]) => void) => void;
    };
  };
}

/**
 * Create and connect a daemon client
 * Returns the connected client or throws if connection fails
 */
export async function connectToDaemon(options?: ConnectOptions): Promise<DaemonClient> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const clientId = await getOrCreateCliClientId();
  const hosts = resolveDaemonHostCandidates(options);
  const nodeWebSocketFactory = createNodeWebSocketFactory();
  let lastError: unknown = null;

  for (const host of hosts) {
    const target = resolveDaemonTarget(host);
    const client = new DaemonClient({
      url: target.url,
      clientId,
      clientType: "cli",
      appVersion: resolveCliVersion(),
      connectTimeoutMs: timeout,
      webSocketFactory: (url: string, config?: { headers?: Record<string, string> }) =>
        nodeWebSocketFactory(url, {
          headers: config?.headers,
          ...(target.type === "ipc" ? { socketPath: target.socketPath } : {}),
        }),
      reconnect: { enabled: false },
    } as unknown as ConstructorParameters<typeof DaemonClient>[0]);

    const connectPromise = client.connect();

    try {
      await connectPromise;
      return client;
    } catch (err) {
      lastError = err;
      await client.close().catch(() => {});
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error(`Unable to connect to Paseo daemon via ${hosts.join(", ")}`);
}

/**
 * Try to connect to the daemon, returns null if connection fails
 */
export async function tryConnectToDaemon(options?: ConnectOptions): Promise<DaemonClient | null> {
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
