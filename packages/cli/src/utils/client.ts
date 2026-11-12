import { createHostClient, parseHostTarget } from "@getpaseo/client/node";
import {
  waitForDaemonReady,
  resolvePaseoHome,
  type DaemonInstance,
  readLocalCredentialForTarget,
} from "@getpaseo/server/daemon-control";
import { describeDaemonTarget, type DaemonTarget } from "./daemon-target.js";
export type { DaemonTarget } from "./daemon-target.js";
import {
  buildDaemonWebSocketUrl,
  normalizeHostPort,
  parseConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getOrCreateCliClientId } from "./client-id.js";
import { resolveCliVersion } from "../version.js";

export interface ConnectOptions {
  target: DaemonTarget;
  timeout?: number;
  instance?: DaemonInstance;
}
export function resolveClientPaseoHome(
  target: DaemonTarget,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return target.kind === "instance" ? target.home : resolvePaseoHome(env);
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
  let code = "DAEMON_UNREACHABLE";
  if (typeof error === "object" && error !== null && "code" in error) code = String(error.code);
  else if (message === "Password required") code = "AUTH_REQUIRED";
  else if (message === "Incorrect password") code = "AUTH_FAILED";
  return {
    code,
    message: message.startsWith("Cannot connect to daemon at ")
      ? message
      : `Cannot connect to daemon at ${describeDaemonTarget(options.target)}: ${message}`,
    details: describeConnectionRemedy(code, options.target),
  };
}

function describeConnectionRemedy(code: string, target: DaemonTarget): string {
  if (code === "AUTH_REQUIRED")
    return "The daemon requires a password. Set PASEO_PASSWORD and retry.";
  if (code === "AUTH_FAILED")
    return "The daemon rejected the password. Check PASEO_PASSWORD and retry.";
  if (target.kind === "instance")
    return `Start with: paseo daemon start --home ${JSON.stringify(target.home)}`;
  return "Check the selected endpoint and credentials. SSH transport does not install or start the daemon.";
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
  const fromUri = parseHostTarget(host).password;
  if (fromUri) return fromUri;
  const fromEnv = process.env.PASEO_PASSWORD;
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

export function resolveDaemonCredential(
  host: string,
  home: string,
): { kind: "password"; password: string } | { kind: "localCredential"; token: string } | null {
  const password = resolveDaemonPassword(host);
  if (password) return { kind: "password", password };
  const token = readLocalCredentialForTarget(home, host);
  return token ? { kind: "localCredential", token } : null;
}

async function connectSelectedDaemon(options: ConnectOptions): Promise<DaemonClient> {
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const host =
    options.target.kind === "endpoint"
      ? options.target.host
      : (
          await waitForDaemonReady(options.target.home, {
            timeoutMs: timeout,
            instance: options.instance,
          })
        ).listen;
  const home = resolveClientPaseoHome(options.target);
  const credential = resolveDaemonCredential(host, home);
  const client = createHostClient(host, {
    clientId: await getOrCreateCliClientId(home),
    clientType: "cli",
    appVersion: resolveCliVersion(),
    ...(credential?.kind === "password" ? { password: credential.password } : {}),
    ...(credential?.kind === "localCredential"
      ? { localCredential: () => readLocalCredentialForTarget(home, host) ?? undefined }
      : {}),
    connectTimeoutMs: timeout,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
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
