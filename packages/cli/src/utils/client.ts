import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  connectToDaemon as connectNodeClient,
  normalizeDaemonHost,
  resolveDaemonPassword,
  resolveDaemonTarget,
  resolveDefaultDaemonHosts,
} from "@getpaseo/client/node";
import { getOrCreateCliClientId } from "./client-id.js";
import { resolveCliVersion } from "../version.js";

export {
  normalizeDaemonHost,
  resolveDaemonPassword,
  resolveDaemonTarget,
  resolveDefaultDaemonHosts,
};

export interface ConnectOptions {
  host?: string;
  timeout?: number;
}

export interface DaemonConnectionCommandError {
  code: "DAEMON_NOT_RUNNING";
  message: string;
  details: string;
}

export function getDaemonHost(options?: ConnectOptions): string {
  return (
    options?.host ?? process.env.PASEO_HOST ?? resolveDefaultDaemonHosts()[0] ?? "localhost:6767"
  );
}

export function resolveDefaultDaemonHost(env: NodeJS.ProcessEnv = process.env): string {
  return resolveDefaultDaemonHosts(env)[0] ?? "localhost:6767";
}

export function buildDaemonConnectionCommandError(options: {
  host?: string;
  error: unknown;
}): DaemonConnectionCommandError {
  const host = getDaemonHost({ host: options.host });
  const message = options.error instanceof Error ? options.error.message : String(options.error);
  return {
    code: "DAEMON_NOT_RUNNING",
    message: `Cannot connect to daemon at ${host}: ${message}`,
    details: "Start the daemon with: paseo daemon start",
  };
}

export async function connectToDaemon(options?: ConnectOptions): Promise<DaemonClient> {
  return connectNodeClient({
    appVersion: resolveCliVersion(),
    clientId: await getOrCreateCliClientId(),
    clientType: "cli",
    host: options?.host,
    timeoutMs: options?.timeout,
  });
}

export async function tryConnectToDaemon(options?: ConnectOptions): Promise<DaemonClient | null> {
  try {
    return await connectToDaemon(options);
  } catch {
    return null;
  }
}

interface AgentLike {
  id: string;
  title?: string | null;
}

export function resolveAgentId(idOrName: string, agents: AgentLike[]): string | null {
  if (!idOrName || agents.length === 0) return null;
  const query = idOrName.toLowerCase();
  const exact = agents.find((agent) => agent.id === idOrName);
  if (exact) return exact.id;
  const prefixes = agents.filter((agent) => agent.id.toLowerCase().startsWith(query));
  if (prefixes.length === 1) return prefixes[0]?.id ?? null;
  const exactTitle = agents.filter((agent) => agent.title?.toLowerCase() === query);
  if (exactTitle.length === 1) return exactTitle[0]?.id ?? null;
  const partialTitle = agents.filter((agent) => agent.title?.toLowerCase().includes(query));
  if (partialTitle.length === 1) return partialTitle[0]?.id ?? null;
  return prefixes[0]?.id ?? null;
}
