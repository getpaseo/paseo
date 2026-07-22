import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { slugify } from "@getpaseo/protocol/branch-slug";
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
import type { PaseoConfigRaw, PaseoConfigRevision } from "@getpaseo/protocol/messages";
import { WebSocket } from "ws";
import { DaemonClient, type WebSocketLike } from "./daemon-client.js";

const DEFAULT_HOST = "localhost:6767";
const DEFAULT_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

export interface NodeHostConnectionOptions {
  appVersion: string;
  clientId?: string;
  clientType?: "cli" | "mcp";
  env?: NodeJS.ProcessEnv;
  host?: string;
  timeoutMs?: number;
}

export interface HostAutomation {
  addProject(rootPath: string): Promise<void>;
  openCheckout(path: string): Promise<void>;
  readProjectConfig(rootPath: string): Promise<{
    config: PaseoConfigRaw | null;
    revision: PaseoConfigRevision | null;
  }>;
  writeProjectConfig(input: {
    rootPath: string;
    config: PaseoConfigRaw;
    expectedRevision: PaseoConfigRevision | null;
  }): Promise<void>;
  ensureCheckout(input: {
    rootPath: string;
    refName: string;
    directoryName: string;
  }): Promise<{ path: string; created: boolean }>;
  close(): Promise<void>;
}

interface PersistedHostConfig {
  daemon?: { listen?: unknown };
}

type DaemonTarget = { type: "tcp"; url: string } | { type: "ipc"; url: string; socketPath: string };

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PASEO_HOME ?? "~/.paseo";
  const expanded =
    configured === "~" ? os.homedir() : configured.replace(/^~\//, `${os.homedir()}/`);
  return path.resolve(expanded);
}

export function normalizeDaemonHost(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.startsWith("tcp://")) {
    try {
      const parsed = parseConnectionUri(value);
      const endpoint = normalizeHostPort(
        parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
      );
      const query = new URLSearchParams();
      if (parsed.useTls) query.set("ssl", "true");
      if (parsed.password) query.set("password", parsed.password);
      const suffix = query.size > 0 ? `?${query.toString()}` : "";
      return `tcp://${endpoint}${suffix}`;
    } catch {
      return null;
    }
  }
  if (value.startsWith("unix://") || value.startsWith("pipe://")) return value;
  if (value.startsWith("\\\\.\\pipe\\")) return `pipe://${value}`;
  if (value.startsWith("/") || value.startsWith("~")) return `unix://${value}`;
  if (/^[A-Za-z]:[/\\]/.test(value)) return null;
  if (/^\d+$/.test(value)) return `127.0.0.1:${value}`;
  const ipv6Loopback = normalizeBareIpv6Loopback(value);
  if (ipv6Loopback) return ipv6Loopback;
  if (value.startsWith("::1:")) return null;
  return value.includes(":") ? value : null;
}

function readConfiguredListen(paseoHome: string): string | null {
  const configPath = path.join(paseoHome, "config.json");
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as PersistedHostConfig;
    return typeof parsed.daemon?.listen === "string" ? parsed.daemon.listen : null;
  } catch {
    return null;
  }
}

function readPidListen(paseoHome: string): string | null {
  const pidPath = path.join(paseoHome, "paseo.pid");
  if (!existsSync(pidPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(pidPath, "utf8")) as {
      pid?: unknown;
      listen?: unknown;
      sockPath?: unknown;
    };
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      !isProcessRunning(parsed.pid)
    ) {
      return null;
    }
    if (typeof parsed.listen === "string") return parsed.listen;
    return typeof parsed.sockPath === "string" ? parsed.sockPath : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

export function resolveDefaultDaemonHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  const paseoHome = resolvePaseoHome(env);
  const direct = normalizeDaemonHost(env.PASEO_LISTEN ?? "");
  const pid = normalizeDaemonHost(readPidListen(paseoHome) ?? "");
  const configuredListen = readConfiguredListen(paseoHome);
  const configured = normalizeDaemonHost(configuredListen ?? "");
  const port =
    !env.PASEO_LISTEN && !configuredListen && /^\d+$/.test(env.PORT ?? "")
      ? normalizeDaemonHost(env.PORT ?? "")
      : null;
  const rawCandidates = [direct, pid, configured].filter(
    (candidate): candidate is string => candidate !== null,
  );
  const ipc = rawCandidates.filter(
    (candidate) => candidate.startsWith("unix://") || candidate.startsWith("pipe://"),
  );
  const tcp = [direct, pid, configured, port].filter(
    (candidate): candidate is string =>
      candidate !== null &&
      !candidate.startsWith("unix://") &&
      !candidate.startsWith("pipe://") &&
      candidate !== "127.0.0.1:6767",
  );
  const candidates = [...ipc, ...tcp];
  candidates.push(DEFAULT_HOST);
  return Array.from(new Set(candidates));
}

export function resolveDaemonTarget(host: string): DaemonTarget {
  const value = host.trim();
  const isIpc =
    value.startsWith("unix://") || value.startsWith("pipe://") || value.startsWith("\\\\.\\pipe\\");
  if (isIpc) {
    const socketPath = value.replace(/^(?:unix|pipe):\/\//, "").trim();
    if (!socketPath) throw new Error("Invalid IPC daemon target: missing socket path");
    return {
      type: "ipc",
      url: value.startsWith("unix://") ? `ws+unix://${socketPath}:/ws` : "ws://localhost/ws",
      socketPath,
    };
  }
  if (value.startsWith("tcp://")) {
    const parsed = parseConnectionUri(value);
    const endpoint = normalizeHostPort(
      parsed.isIpv6 ? `[${parsed.host}]:${parsed.port}` : `${parsed.host}:${parsed.port}`,
    );
    return { type: "tcp", url: buildDaemonWebSocketUrl(endpoint, { useTls: parsed.useTls }) };
  }
  const endpoint = normalizeBareIpv6Loopback(value) ?? normalizeHostPort(value);
  return { type: "tcp", url: buildDaemonWebSocketUrl(endpoint, { useTls: false }) };
}

function normalizeBareIpv6Loopback(value: string): string | null {
  const match = value.match(/^::1:(\d{1,5})$/);
  if (!match) return null;
  try {
    return normalizeHostPort(`[::1]:${match[1]}`);
  } catch {
    return null;
  }
}

export function resolveDaemonPassword(
  host: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (host.startsWith("tcp://")) {
    const password = parseConnectionUri(host).password;
    if (password) return password;
  }
  return env.PASEO_PASSWORD?.trim() || undefined;
}

function createWebSocket(
  target: DaemonTarget,
): (
  url: string,
  options?: { headers?: Record<string, string>; protocols?: string[] },
) => WebSocketLike {
  return (url, options) =>
    new WebSocket(url, options?.protocols, {
      headers: options?.headers,
      ...(target.type === "ipc" ? { socketPath: target.socketPath } : {}),
    }) as unknown as WebSocketLike;
}

async function connectCandidate(
  host: string,
  options: Required<
    Pick<NodeHostConnectionOptions, "appVersion" | "clientId" | "clientType" | "timeoutMs">
  > & {
    env: NodeJS.ProcessEnv;
  },
): Promise<DaemonClient> {
  const target = resolveDaemonTarget(host);
  const client = new DaemonClient({
    url: target.url,
    clientId: options.clientId,
    clientType: options.clientType,
    appVersion: options.appVersion,
    password: resolveDaemonPassword(host, options.env),
    connectTimeoutMs: options.timeoutMs,
    webSocketFactory: createWebSocket(target),
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function connectRelay(
  offer: ConnectionOffer,
  options: Required<
    Pick<NodeHostConnectionOptions, "appVersion" | "clientId" | "clientType" | "timeoutMs">
  >,
): Promise<DaemonClient> {
  const url = buildRelayWebSocketUrl({
    endpoint: offer.relay.endpoint,
    serverId: offer.serverId,
    role: "client",
    useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(offer.relay.endpoint),
  });
  const client = new DaemonClient({
    url,
    clientId: options.clientId,
    clientType: options.clientType,
    appVersion: options.appVersion,
    connectTimeoutMs: options.timeoutMs,
    webSocketFactory: createWebSocket({ type: "tcp", url }),
    e2ee: { enabled: true, daemonPublicKeyB64: offer.daemonPublicKeyB64 },
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export async function connectToDaemon(options: NodeHostConnectionOptions): Promise<DaemonClient> {
  const env = options.env ?? process.env;
  let hosts: string[];
  if (options.host) hosts = [options.host];
  else if (env.PASEO_HOST) hosts = [env.PASEO_HOST];
  else hosts = resolveDefaultDaemonHosts(env);
  const identity = {
    appVersion: options.appVersion,
    clientId: options.clientId ?? `node-${randomUUID()}`,
    clientType: options.clientType ?? ("cli" as const),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  if (hosts.length === 1) {
    const offer = parseOffer(hosts[0]);
    if (offer) return connectRelay(offer, identity);
  }
  let lastError: unknown = new Error("No Paseo daemon targets were discovered.");
  for (const host of hosts) {
    try {
      return await connectCandidate(host, {
        ...identity,
        env,
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function parseOffer(host: string): ConnectionOffer | null {
  try {
    return parseConnectionOfferFromUrl(host);
  } catch (error) {
    const isPaseoUrl = host.startsWith("paseo://") || host.includes("/connect#");
    if (isPaseoUrl) throw error;
    return null;
  }
}

class DaemonHostAutomation implements HostAutomation {
  constructor(private readonly client: DaemonClient) {}

  async addProject(rootPath: string): Promise<void> {
    const result = await this.client.addProject(rootPath);
    if (!result.project) throw new Error(result.error ?? `Unable to add ${rootPath}`);
  }

  async openCheckout(checkoutPath: string): Promise<void> {
    const result = await this.client.openProject(checkoutPath);
    if (!result.workspace) throw new Error(result.error ?? `Unable to open ${checkoutPath}`);
  }

  async readProjectConfig(rootPath: string) {
    const result = await this.client.readProjectConfig(rootPath);
    if (!result.ok) throw new Error(`Unable to read project config: ${result.error.code}`);
    return { config: result.config, revision: result.revision };
  }

  async writeProjectConfig(input: {
    rootPath: string;
    config: PaseoConfigRaw;
    expectedRevision: PaseoConfigRevision | null;
  }): Promise<void> {
    const result = await this.client.writeProjectConfig({
      repoRoot: input.rootPath,
      config: input.config,
      expectedRevision: input.expectedRevision,
    });
    if (!result.ok) throw new Error(`Unable to write project config: ${result.error.code}`);
  }

  async ensureCheckout(input: {
    rootPath: string;
    refName: string;
    directoryName: string;
  }): Promise<{ path: string; created: boolean }> {
    const refName = input.refName.replace(/^refs\/heads\//, "");
    if (!refName) throw new Error("Checkout branch is required");
    const directorySlug = slugify(input.directoryName);
    if (!directorySlug)
      throw new Error(`Unable to derive a checkout name from ${input.directoryName}`);
    const listed = await this.client.getPaseoWorktreeList({ repoRoot: input.rootPath });
    if (listed.error)
      throw new Error(`Unable to inspect existing checkouts: ${listed.error.message}`);
    const existing = listed.worktrees.find(
      (worktree) => path.basename(worktree.worktreePath) === directorySlug,
    );
    if (existing && existing.branchName !== refName) {
      throw new Error(
        `Checkout name ${directorySlug} is already used by branch ${existing.branchName ?? "unknown"}.`,
      );
    }
    if (existing && existsSync(existing.worktreePath)) {
      const opened = await this.client.openProject(existing.worktreePath);
      if (!opened.workspace) {
        throw new Error(opened.error ?? `Unable to open ${existing.worktreePath}`);
      }
      return { path: existing.worktreePath, created: false };
    }

    await removeMissingCheckoutRegistration(input.rootPath, refName);

    const result = await this.client.createPaseoWorktree({
      cwd: input.rootPath,
      worktreeSlug: directorySlug,
      action: "checkout",
      refName,
    });
    const checkoutPath = result.workspace?.workspaceDirectory;
    if (!checkoutPath) throw new Error(result.error ?? `Unable to check out ${refName}`);
    return { path: checkoutPath, created: true };
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

async function removeMissingCheckoutRegistration(rootPath: string, refName: string): Promise<void> {
  const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], {
    cwd: rootPath,
    encoding: "utf8",
  });
  const expectedBranch = `refs/heads/${refName.replace(/^refs\/heads\//, "")}`;
  const stale = parseGitWorktreeList(stdout).find(
    (worktree) => worktree.branch === expectedBranch && !existsSync(worktree.path),
  );
  if (!stale) return;

  // ensureCheckout is the explicit repair boundary: remove only the missing
  // registration that blocks the requested branch, never unrelated worktrees.
  await execFileAsync("git", ["worktree", "remove", "--force", stale.path], {
    cwd: rootPath,
  });
}

function parseGitWorktreeList(stdout: string): Array<{ path: string; branch: string | null }> {
  return stdout
    .trim()
    .split(/\n\s*\n/)
    .flatMap((entry) => {
      const worktreePath = entry.match(/^worktree (.+)$/m)?.[1];
      if (!worktreePath) return [];
      return [{ path: worktreePath, branch: entry.match(/^branch (.+)$/m)?.[1] ?? null }];
    });
}

export async function connectHostAutomation(
  options: NodeHostConnectionOptions,
): Promise<HostAutomation> {
  const client = await connectToDaemon(options);
  if (client.getLastServerInfoMessage()?.features?.hostAutomation !== true) {
    await client.close();
    throw new Error(
      "This Paseo host does not support project import. Update the host to use this.",
    );
  }
  return new DaemonHostAutomation(client);
}
