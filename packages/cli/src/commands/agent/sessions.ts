import type { Command } from "commander";
import { realpathSync } from "node:fs";
import path from "node:path";
import type { AgentSnapshotPayload, FetchPersistedAgentsEntry } from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandError,
  CommandOptions,
  ListResult,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";

type FetchPersistedAgentsOptions = NonNullable<
  Parameters<Awaited<ReturnType<typeof connectToDaemon>>["fetchPersistedAgents"]>[0]
>;

export interface AgentSessionListItem {
  sessionId: string;
  shortSessionId: string;
  title: string;
  provider: string;
  cwd: string;
  updated: string;
  messages: number;
  handoff: string;
}

export interface AgentSessionsOptions extends CommandOptions {
  provider?: string;
  cwd?: string;
  limit?: string;
}

export interface AgentResumeSessionOptions extends CommandOptions {
  provider?: string;
  cwd?: string;
  limit?: string;
}

export interface AgentResumeSessionResult {
  agentId: string;
  sessionId: string;
  provider: string;
  cwd: string;
  status: string;
  title: string | null;
  warning: string | null;
}

export type AgentSessionsResult = ListResult<AgentSessionListItem>;
export type AgentResumeSessionCommandResult = SingleResult<AgentResumeSessionResult>;

export function addSessionsOptions(cmd: Command): Command {
  return cmd
    .description("List provider sessions that can be resumed into Paseo")
    .option("--provider <provider>", "Provider to query", "opencode")
    .option("--cwd <path>", "Project directory to query (default: current directory)")
    .option("--limit <count>", "Maximum sessions to return", "20");
}

export function addResumeSessionOptions(cmd: Command): Command {
  return cmd
    .description("Resume a provider session into a Paseo-managed agent")
    .argument("<session>", "Session ID or unique prefix")
    .option("--provider <provider>", "Provider to query", "opencode")
    .option("--cwd <path>", "Project directory to query (default: current directory)")
    .option("--limit <count>", "Maximum sessions to search", "200");
}

export function addHandoffOptions(cmd: Command): Command {
  return cmd
    .description("Hand off an idle OpenCode session into Paseo after quitting terminal OpenCode")
    .argument("<session>", "Session ID or unique prefix")
    .option("--provider <provider>", "Provider to query", "opencode")
    .option("--cwd <path>", "Project directory to query (default: current directory)")
    .option("--limit <count>", "Maximum sessions to search", "200");
}

export const agentSessionsSchema: OutputSchema<AgentSessionListItem> = {
  idField: "sessionId",
  columns: [
    { header: "SESSION ID", field: "shortSessionId", width: 12 },
    { header: "TITLE", field: "title", width: 24 },
    { header: "PROVIDER", field: "provider", width: 12 },
    { header: "UPDATED", field: "updated", width: 15 },
    { header: "HANDOFF", field: "handoff", width: 24 },
    { header: "MESSAGES", field: "messages", width: 8, align: "right" },
    { header: "CWD", field: "cwd", width: 30 },
  ],
};

export const agentResumeSessionSchema: OutputSchema<AgentResumeSessionResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "SESSION ID", field: "sessionId", width: 12 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "PROVIDER", field: "provider", width: 12 },
    { header: "CWD", field: "cwd", width: 30 },
    { header: "TITLE", field: "title", width: 24 },
    { header: "WARNING", field: "warning", width: 32 },
  ],
};

const RECENT_HANDOFF_ACTIVITY_MS = 10 * 60 * 1000;
const RECENT_HANDOFF_WARNING = "quit terminal OpenCode first";

function relativeTime(date: Date | string): string {
  const now = Date.now();
  const then = new Date(date).getTime();
  const seconds = Math.floor((now - then) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} minutes ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hours ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function shortenPath(filePath: string): string {
  const home = process.env.HOME;
  if (home && filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

function parseLimit(value: string | undefined): number {
  const raw = value ?? "20";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    const error: CommandError = {
      code: "INVALID_LIMIT",
      message: "--limit must be an integer between 1 and 200",
    };
    throw error;
  }
  return parsed;
}

function isRecentlyActive(value: Date | string): boolean {
  const updatedAt = new Date(value).getTime();
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < RECENT_HANDOFF_ACTIVITY_MS;
}

function handoffStatus(entry: FetchPersistedAgentsEntry): string {
  return isRecentlyActive(entry.lastActivityAt) ? RECENT_HANDOFF_WARNING : "ready";
}

function normalizeProvider(value: string | undefined): string {
  const provider = value?.trim() || "opencode";
  if (!provider) {
    const error: CommandError = {
      code: "INVALID_PROVIDER",
      message: "--provider cannot be empty",
    };
    throw error;
  }
  return provider;
}

function normalizeCwd(value: string | undefined): string {
  const cwd = value?.trim() || process.cwd();
  const resolved = path.resolve(cwd);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function buildAgentSessionsFetchOptions(
  options: Pick<AgentSessionsOptions, "provider" | "cwd" | "limit">,
): FetchPersistedAgentsOptions {
  const provider = normalizeProvider(options.provider);
  const cwd = normalizeCwd(options.cwd);
  const limit = parseLimit(options.limit);

  return {
    provider,
    cwd,
    page: { limit },
  };
}

export function toAgentSessionListItem(entry: FetchPersistedAgentsEntry): AgentSessionListItem {
  return {
    sessionId: entry.sessionId,
    shortSessionId: entry.sessionId.slice(0, 12),
    title: entry.title ?? "-",
    provider: entry.provider,
    cwd: shortenPath(entry.cwd),
    updated: relativeTime(entry.lastActivityAt),
    messages: entry.timeline.length,
    handoff: handoffStatus(entry),
  };
}

export function resolvePersistedSession(
  sessionIdOrPrefix: string,
  entries: FetchPersistedAgentsEntry[],
): FetchPersistedAgentsEntry {
  const query = sessionIdOrPrefix.trim();
  if (!query) {
    const error: CommandError = {
      code: "INVALID_SESSION_ID",
      message: "Session ID cannot be empty",
    };
    throw error;
  }

  const exactMatch = entries.find((entry) => entry.sessionId === query);
  if (exactMatch) {
    return exactMatch;
  }

  const prefixMatches = entries.filter((entry) => entry.sessionId.startsWith(query));
  if (prefixMatches.length === 1) {
    return prefixMatches[0]!;
  }
  if (prefixMatches.length > 1) {
    const error: CommandError = {
      code: "AMBIGUOUS_SESSION_ID",
      message: `Session prefix '${query}' matched multiple sessions`,
      details: prefixMatches.map((entry) => entry.sessionId),
    };
    throw error;
  }

  const error: CommandError = {
    code: "SESSION_NOT_FOUND",
    message: `Session not found: ${query}`,
    details: "Use paseo agent sessions to list available sessions",
  };
  throw error;
}

function toAgentResumeSessionResult(
  agent: AgentSnapshotPayload,
  entry: FetchPersistedAgentsEntry,
): AgentResumeSessionResult {
  return {
    agentId: agent.id,
    sessionId: entry.sessionId,
    provider: agent.provider,
    cwd: agent.cwd,
    status: agent.status,
    title: agent.title,
    warning: handoffStatus(entry) === RECENT_HANDOFF_WARNING ? RECENT_HANDOFF_WARNING : null,
  };
}

export async function runSessionsCommand(
  options: AgentSessionsOptions,
  _command: Command,
): Promise<AgentSessionsResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  let client;
  try {
    client = await connectToDaemon({ host: options.host as string | undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    const payload = await client.fetchPersistedAgents(buildAgentSessionsFetchOptions(options));
    return {
      type: "list",
      data: payload.entries.map(toAgentSessionListItem),
      schema: agentSessionsSchema,
    };
  } finally {
    await client.close();
  }
}

export async function runResumeSessionCommand(
  sessionIdOrPrefix: string,
  options: AgentResumeSessionOptions,
  _command: Command,
): Promise<AgentResumeSessionCommandResult> {
  const host = getDaemonHost({ host: options.host as string | undefined });

  let client;
  try {
    client = await connectToDaemon({ host: options.host as string | undefined });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }

  try {
    const payload = await client.fetchPersistedAgents(buildAgentSessionsFetchOptions(options));
    const entry = resolvePersistedSession(sessionIdOrPrefix, payload.entries);
    if (!entry.persistence) {
      const error: CommandError = {
        code: "SESSION_NOT_RESUMABLE",
        message: `Session is missing a persistence handle: ${entry.sessionId}`,
      };
      throw error;
    }
    const agent = await client.resumeAgent(entry.persistence, {
      cwd: entry.cwd,
      title: entry.title,
    });
    return {
      type: "single",
      data: toAgentResumeSessionResult(agent, entry),
      schema: agentResumeSessionSchema,
    };
  } finally {
    await client.close();
  }
}

export async function runHandoffCommand(
  sessionIdOrPrefix: string,
  options: AgentResumeSessionOptions,
  command: Command,
): Promise<AgentResumeSessionCommandResult> {
  return runResumeSessionCommand(sessionIdOrPrefix, options, command);
}
