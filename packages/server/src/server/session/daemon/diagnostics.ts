import { open, statfs } from "node:fs/promises";
import { cpus, freemem, loadavg, platform, release, totalmem, type } from "node:os";
import path from "node:path";

import type pino from "pino";

import type { ManagedAgent, ProviderAvailability } from "../../agent/agent-manager.js";
import type { WebSocketRuntimeDiagnosticSnapshot } from "../../websocket/runtime-metrics.js";
import type { PersistedProjectRecord, PersistedWorkspaceRecord } from "../../workspace-registry.js";
import { execCommand } from "../../../utils/spawn.js";
import type { DaemonRuntimeConfig } from "./daemon-session.js";

interface DiagnosticEntry {
  label: string;
  value: string;
}

export interface DaemonDiagnosticsOptions {
  paseoHome: string;
  serverId: string | undefined;
  daemonVersion: string | undefined;
  daemonRuntimeConfig: DaemonRuntimeConfig | undefined;
  listAgents: () => ManagedAgent[];
  listProjects: () => Promise<PersistedProjectRecord[]>;
  listWorkspaces: () => Promise<PersistedWorkspaceRecord[]>;
  listProviderAvailability: () => Promise<ProviderAvailability[]>;
  getWebSocketRuntimeMetrics: () => DaemonWebSocketRuntimeDiagnosticSnapshot | null;
  logger: pino.Logger;
}

interface DiagnosticWebSocketRuntimeMetrics {
  terminalDirectorySubscriptionCount: number;
  terminalSubscriptionCount: number;
  inflightRequests: number;
  peakInflightRequests: number;
  checkoutDiffTargetCount: number;
  checkoutDiffSubscriptionCount: number;
  checkoutDiffWatcherCount: number;
  checkoutDiffFallbackRefreshTargetCount: number;
}

interface DiagnosticAgentRuntimeMetrics {
  total: number;
  byLifecycle: Record<string, number>;
  withActiveForegroundTurn: number;
  timelineStats: {
    totalItems: number;
    maxItemsPerAgent: number;
  };
}

export type DaemonWebSocketRuntimeDiagnosticSnapshot = WebSocketRuntimeDiagnosticSnapshot<
  DiagnosticWebSocketRuntimeMetrics,
  DiagnosticAgentRuntimeMetrics
>;

const TOOL_TIMEOUT_MS = 3_000;
const TOOL_OUTPUT_LIMIT = 512;
const LOG_TAIL_LINES = 80;
const LOG_TAIL_MAX_BYTES = 64 * 1024;

export async function collectDaemonDiagnostics(options: DaemonDiagnosticsOptions): Promise<string> {
  const sections: string[] = [
    formatSection("Paseo diagnostics", [
      { label: "Collected at", value: new Date().toISOString() },
      { label: "Server ID", value: options.serverId ?? "unknown" },
      { label: "Daemon version", value: options.daemonVersion ?? "unknown" },
    ]),
  ];

  sections.push(
    await safeSection("Daemon process", () => collectProcessEntries(options), options.logger),
  );
  sections.push(
    await safeSection("Runtime config", () => collectRuntimeConfigEntries(options), options.logger),
  );
  sections.push(await safeSection("System", collectSystemEntries, options.logger));
  sections.push(await safeSection("Disk", () => collectDiskEntries(options), options.logger));
  sections.push(await safeSection("Agents", () => collectAgentEntries(options), options.logger));
  sections.push(
    await safeSection("Workspaces", () => collectWorkspaceEntries(options), options.logger),
  );
  sections.push(
    await safeSection("Providers", () => collectProviderEntries(options), options.logger),
  );
  sections.push(
    await safeSection(
      "WebSocket runtime metrics",
      () => collectWebSocketRuntimeEntries(options),
      options.logger,
    ),
  );
  sections.push(await safeSection("Tools", collectToolEntries, options.logger));
  sections.push(await safeLogTailSection(options));

  return redactDiagnostic(sections.filter(Boolean).join("\n\n"), options);
}

async function safeSection(
  title: string,
  collect: () => DiagnosticEntry[] | Promise<DiagnosticEntry[]>,
  logger: pino.Logger,
): Promise<string> {
  try {
    return formatSection(title, await collect());
  } catch (error) {
    logger.debug({ err: error, title }, "diagnostic section failed");
    return formatSection(title, [{ label: "Error", value: toErrorMessage(error) }]);
  }
}

function formatSection(title: string, entries: DiagnosticEntry[]): string {
  return [title, ...entries.map((entry) => `  ${entry.label}: ${entry.value}`)].join("\n");
}

function collectProcessEntries(options: DaemonDiagnosticsOptions): DiagnosticEntry[] {
  const memory = process.memoryUsage();
  return [
    { label: "PID", value: String(process.pid) },
    { label: "Node", value: process.version },
    { label: "Node path", value: process.execPath },
    { label: "PATH", value: getEnvValue("PATH", "Path") ?? "unset" },
    { label: "Shell", value: formatDaemonShell() },
    { label: "Uptime", value: formatDurationMs(process.uptime() * 1000) },
    { label: "Paseo home", value: options.paseoHome },
    { label: "RSS", value: formatBytes(memory.rss) },
    {
      label: "Heap used",
      value: `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`,
    },
    { label: "External", value: formatBytes(memory.external) },
  ];
}

function collectRuntimeConfigEntries(options: DaemonDiagnosticsOptions): DiagnosticEntry[] {
  const relay = options.daemonRuntimeConfig?.relay ?? null;
  return [
    { label: "Listen", value: formatListenKind(options.daemonRuntimeConfig?.listen ?? null) },
    { label: "Relay enabled", value: relay ? String(relay.enabled) : "false" },
    { label: "Relay endpoint configured", value: relay?.endpoint ? "true" : "false" },
    { label: "Relay public endpoint configured", value: relay?.publicEndpoint ? "true" : "false" },
    { label: "Relay TLS", value: relay ? String(relay.useTls) : "n/a" },
    { label: "Relay public TLS", value: relay ? String(relay.publicUseTls) : "n/a" },
  ];
}

function collectSystemEntries(): DiagnosticEntry[] {
  const loads = loadavg();
  return [
    { label: "OS", value: `${type()} ${release()}` },
    { label: "Platform", value: `${platform()} ${process.arch}` },
    { label: "CPU cores", value: String(cpus().length) },
    { label: "Load avg", value: loads.map((value) => value.toFixed(2)).join(", ") },
    { label: "Memory free", value: `${formatBytes(freemem())} / ${formatBytes(totalmem())}` },
  ];
}

async function collectDiskEntries(options: DaemonDiagnosticsOptions): Promise<DiagnosticEntry[]> {
  const stats = await statfs(options.paseoHome);
  const freeBytes = stats.bavail * stats.bsize;
  const totalBytes = stats.blocks * stats.bsize;
  return [
    { label: "Path", value: options.paseoHome },
    { label: "Free", value: `${formatBytes(freeBytes)} / ${formatBytes(totalBytes)}` },
  ];
}

function collectAgentEntries(options: DaemonDiagnosticsOptions): DiagnosticEntry[] {
  const agents = options.listAgents();
  return [
    { label: "Total", value: String(agents.length) },
    { label: "By provider", value: formatCountMap(countBy(agents, (agent) => agent.provider)) },
    { label: "By lifecycle", value: formatCountMap(countBy(agents, (agent) => agent.lifecycle)) },
    {
      label: "Pending permissions",
      value: String(
        agents.reduce((total, agent) => total + (agent.pendingPermissions?.size ?? 0), 0),
      ),
    },
  ];
}

async function collectWorkspaceEntries(
  options: DaemonDiagnosticsOptions,
): Promise<DiagnosticEntry[]> {
  const [projects, workspaces] = await Promise.all([
    options.listProjects(),
    options.listWorkspaces(),
  ]);
  const activeProjects = projects.filter((project) => !project.archivedAt);
  const activeWorkspaces = workspaces.filter((workspace) => !workspace.archivedAt);
  return [
    { label: "Projects", value: `${activeProjects.length} active / ${projects.length} total` },
    {
      label: "Workspaces",
      value: `${activeWorkspaces.length} active / ${workspaces.length} total`,
    },
    {
      label: "Workspaces by kind",
      value: formatCountMap(countBy(activeWorkspaces, (workspace) => workspace.kind)),
    },
  ];
}

async function collectProviderEntries(
  options: DaemonDiagnosticsOptions,
): Promise<DiagnosticEntry[]> {
  const providers = await options.listProviderAvailability();
  return [
    { label: "Total", value: String(providers.length) },
    {
      label: "Available",
      value: String(providers.filter((provider) => provider.available).length),
    },
    {
      label: "Unavailable",
      value:
        providers
          .filter((provider) => !provider.available)
          .map((provider) =>
            provider.error ? `${provider.provider} (${provider.error})` : provider.provider,
          )
          .join(", ") || "none",
    },
  ];
}

async function collectToolEntries(): Promise<DiagnosticEntry[]> {
  const [git, gh] = await Promise.all([
    checkTool("git", ["--version"]),
    checkTool("gh", ["--version"]),
  ]);
  return [
    { label: "git", value: git },
    { label: "gh", value: gh },
  ];
}

function collectWebSocketRuntimeEntries(options: DaemonDiagnosticsOptions): DiagnosticEntry[] {
  const snapshot = options.getWebSocketRuntimeMetrics();
  if (!snapshot) {
    return [{ label: "Status", value: "no runtime metrics window has been flushed yet" }];
  }

  const runtime = snapshot.runtime;
  const agents = snapshot.agents;

  return [
    { label: "Collected at", value: snapshot.collectedAt },
    { label: "Window", value: formatDurationMs(snapshot.windowMs) },
    { label: "Final", value: String(snapshot.final) },
    {
      label: "Sessions",
      value: [
        `active=${snapshot.sessions.activeConnections}`,
        `externalKeys=${snapshot.sessions.externalSessionKeys}`,
        `reconnectGrace=${snapshot.sessions.reconnectGraceSessions}`,
      ].join(", "),
    },
    {
      label: "Sockets",
      value: [
        `active=${snapshot.sockets.activeSockets}`,
        `pending=${snapshot.sockets.pendingConnections}`,
      ].join(", "),
    },
    {
      label: "Runtime requests",
      value: [
        `inflight=${formatNumberMetric(runtime.inflightRequests)}`,
        `peakInflight=${formatNumberMetric(runtime.peakInflightRequests)}`,
      ].join(", "),
    },
    {
      label: "Terminal subscriptions",
      value: [
        `terminals=${formatNumberMetric(runtime.terminalSubscriptionCount)}`,
        `directories=${formatNumberMetric(runtime.terminalDirectorySubscriptionCount)}`,
      ].join(", "),
    },
    {
      label: "Checkout diff",
      value: [
        `targets=${formatNumberMetric(runtime.checkoutDiffTargetCount)}`,
        `subscriptions=${formatNumberMetric(runtime.checkoutDiffSubscriptionCount)}`,
        `watchers=${formatNumberMetric(runtime.checkoutDiffWatcherCount)}`,
        `fallbackRefreshTargets=${formatNumberMetric(
          runtime.checkoutDiffFallbackRefreshTargetCount,
        )}`,
      ].join(", "),
    },
    {
      label: "Buffered amount",
      value: `p95=${formatBytes(snapshot.bufferedAmount.p95)}, max=${formatBytes(
        snapshot.bufferedAmount.max,
      )}`,
    },
    { label: "Event loop delay", value: formatEventLoopDelay(snapshot.eventLoopDelay) },
    { label: "Latency", value: formatLatencyStats(snapshot.latency) },
    { label: "Inbound messages", value: formatTopCounts(snapshot.inboundMessageTypesTop) },
    {
      label: "Inbound session requests",
      value: formatTopCounts(snapshot.inboundSessionRequestTypesTop),
    },
    { label: "Outbound messages", value: formatTopCounts(snapshot.outboundMessageTypesTop) },
    {
      label: "Outbound session messages",
      value: formatTopCounts(snapshot.outboundSessionMessageTypesTop),
    },
    { label: "Agent streams", value: formatTopCounts(snapshot.outboundAgentStreamTypesTop) },
    { label: "Agent stream agents", value: formatTopCounts(snapshot.outboundAgentStreamAgentsTop) },
    { label: "Binary frames", value: formatTopCounts(snapshot.outboundBinaryFrameTypesTop) },
    { label: "Counters", value: formatNonZeroNumberRecord(snapshot.counters) },
    {
      label: "Agent metrics",
      value: [
        `total=${formatNumberMetric(agents.total)}`,
        `activeForegroundTurns=${formatNumberMetric(agents.withActiveForegroundTurn)}`,
      ].join(", "),
    },
    { label: "Agent lifecycle", value: formatNumberRecord(agents.byLifecycle) },
    {
      label: "Agent timelines",
      value: [
        `items=${formatNumberMetric(agents.timelineStats?.totalItems)}`,
        `maxPerAgent=${formatNumberMetric(agents.timelineStats?.maxItemsPerAgent)}`,
      ].join(", "),
    },
  ];
}

function formatTopCounts(counts: Array<[string, number]>): string {
  if (counts.length === 0) return "none";
  return counts.map(([key, count]) => `${key}=${count}`).join(", ");
}

function formatLatencyStats(stats: DaemonWebSocketRuntimeDiagnosticSnapshot["latency"]): string {
  if (stats.length === 0) return "none";
  return stats
    .map(
      (stat) =>
        `${stat.type} count=${stat.count} p50=${formatMilliseconds(
          stat.p50Ms,
        )} max=${formatMilliseconds(stat.maxMs)} total=${formatMilliseconds(stat.totalMs)}`,
    )
    .join("; ");
}

function formatEventLoopDelay(
  stats: DaemonWebSocketRuntimeDiagnosticSnapshot["eventLoopDelay"],
): string {
  if (!stats) return "unavailable";
  return `p50=${formatMilliseconds(stats.p50Ms)}, p99=${formatMilliseconds(
    stats.p99Ms,
  )}, max=${formatMilliseconds(stats.maxMs)}`;
}

function formatNumberRecord(record: object | undefined): string {
  if (!record) return "unknown";
  const entries = Object.entries(record).filter(([, value]) => Number.isFinite(value));
  if (entries.length === 0) return "none";
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatNonZeroNumberRecord(record: object): string {
  const entries = Object.entries(record).filter(
    ([, value]) => Number.isFinite(value) && value !== 0,
  );
  if (entries.length === 0) return "none";
  return entries
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

function formatNumberMetric(value: number | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "unknown";
  return String(value);
}

function formatMilliseconds(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  return `${Math.round(ms)}ms`;
}

async function checkTool(command: string, args: string[]): Promise<string> {
  try {
    const result = await execCommand(command, args, {
      timeout: TOOL_TIMEOUT_MS,
      maxBuffer: TOOL_OUTPUT_LIMIT * 2,
    });
    const output = truncateForDiagnostic(
      (result.stdout || result.stderr).trim(),
      TOOL_OUTPUT_LIMIT,
    );
    return output || "ok";
  } catch (error) {
    return `error: ${truncateForDiagnostic(toErrorMessage(error), TOOL_OUTPUT_LIMIT)}`;
  }
}

async function safeLogTailSection(options: DaemonDiagnosticsOptions): Promise<string> {
  const logPath = path.join(options.paseoHome, "daemon.log");
  try {
    const tail = await tailFile(logPath, LOG_TAIL_LINES, LOG_TAIL_MAX_BYTES);
    return ["Daemon log tail", `  Path: ${logPath}`, tail ? tail : "  No log lines found"].join(
      "\n",
    );
  } catch (error) {
    options.logger.debug({ err: error, logPath }, "diagnostic log tail failed");
    return ["Daemon log tail", `  Path: ${logPath}`, `  Error: ${toErrorMessage(error)}`].join(
      "\n",
    );
  }
}

async function tailFile(filePath: string, lines: number, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stats.size - length);
    return buffer
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-lines)
      .map((line) => `  ${line}`)
      .join("\n");
  } finally {
    await handle.close();
  }
}

function formatListenKind(listen: string | null): string {
  if (!listen) return "not configured";
  if (listen.startsWith("unix://") || listen.startsWith("/")) return "local socket";
  if (listen.startsWith("pipe://") || listen.startsWith("\\\\.\\pipe\\")) return "local pipe";
  return "direct TCP";
}

function countBy<T>(
  items: T[],
  getKey: (item: T) => string | null | undefined,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = getKey(item) || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function formatCountMap(counts: Map<string, number>): string {
  if (counts.size === 0) return "none";
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key}=${count}`)
    .join(", ");
}

function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
  return `${remainingSeconds}s`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function truncateForDiagnostic(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...(truncated)`;
}

function formatDaemonShell(): string {
  const shell = getEnvValue("SHELL");
  if (shell) return `SHELL=${shell}`;
  const comspec = getEnvValue("ComSpec", "COMSPEC");
  if (comspec) return `ComSpec=${comspec}`;
  return "unset";
}

function getEnvValue(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }

  const lowerNames = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(process.env)) {
    if (value && lowerNames.has(key.toLowerCase())) return value;
  }

  return null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

export function redactDiagnostic(
  value: string,
  options?: Partial<DaemonDiagnosticsOptions>,
): string {
  let redacted = value;
  const sensitiveValues = [
    options?.daemonRuntimeConfig?.listen,
    options?.daemonRuntimeConfig?.relay?.endpoint,
    options?.daemonRuntimeConfig?.relay?.publicEndpoint,
  ].filter((item): item is string => Boolean(item));

  for (const sensitive of sensitiveValues) {
    redacted = redacted.split(sensitive).join("[redacted]");
  }

  return redacted
    .replace(/paseo:\/\/\S+/gi, "paseo://[redacted]")
    .replace(
      /([?&](?:password|token|secret|key|publicKey|daemonPublicKeyB64)=)[^&\s"']+/gi,
      "$1[redacted]",
    )
    .replace(
      /((?:password|token|secret|authorization|api[_-]?key|daemonPublicKeyB64|relayKey)\s*[:=]\s*)("[^"]+"|'[^']+'|[^\s,}]+)/gi,
      "$1[redacted]",
    );
}
