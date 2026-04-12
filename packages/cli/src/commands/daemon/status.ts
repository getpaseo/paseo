import type { Command } from "commander";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { getOrCreateServerId, findExecutable, applyProviderEnv } from "@getpaseo/server";

const execFileAsync = promisify(execFile);
import { tryConnectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { resolveLocalDaemonState, resolveTcpHostFromListen } from "./local-daemon.js";
import { resolveNodePathFromPid } from "./runtime-toolchain.js";

interface ProviderBinaryStatus {
  label: string;
  path: string | null;
  version: string | null;
}

interface DaemonStatus {
  serverId: string | null;
  localDaemon: "running" | "stopped" | "stale_pid" | "unresponsive";
  connectedDaemon: "reachable" | "unreachable" | "not_probed";
  home: string;
  listen: string;
  hostname: string | null;
  pid: number | null;
  startedAt: string | null;
  owner: string | null;
  logPath: string;
  runningAgents: number | null;
  idleAgents: number | null;
  daemonNode: string;
  cliNode: string;
  cliVersion: string;
  daemonVersion: string | null;
  desktopManaged: boolean;
  providers: ProviderBinaryStatus[];
  note?: string;
}

interface StatusRow {
  key: string;
  value: string;
}

type CliPackageJson = {
  version?: unknown;
};

const require = createRequire(import.meta.url);

function normalizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function shortenMessage(message: string, max = 120): string {
  const normalized = message.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 3)}...`;
}

function appendNote(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current;
  if (!current) return next;
  return `${current}; ${next}`;
}

function resolveCliVersion(): string {
  try {
    const packageJson = require("../../../package.json") as CliPackageJson;
    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version.trim();
    }
  } catch {
    // Fall through.
  }
  return "unknown";
}

function createStatusSchema(status: DaemonStatus): OutputSchema<StatusRow> {
  return {
    idField: "key",
    columns: [
      { header: "KEY", field: "key" },
      {
        header: "VALUE",
        field: "value",
        color: (_, item) => {
          if (item.key === "Local Daemon") {
            if (item.value === "running") return "green";
            if (item.value === "unresponsive") return "yellow";
            return "red";
          }
          if (item.key === "Connected Daemon") {
            if (item.value === "reachable") return "green";
            if (item.value === "not_probed") return "yellow";
            return "red";
          }
          if (item.key.startsWith("  ")) {
            if (item.value === "not found") return "red";
            if (item.value.endsWith("(--version failed)")) return "yellow";
            return "green";
          }
          return undefined;
        },
      },
    ],
    serialize: () => status,
  };
}

function toStatusRows(status: DaemonStatus): StatusRow[] {
  const rows: StatusRow[] = [
    { key: "Server ID", value: status.serverId ?? "-" },
    { key: "Local Daemon", value: status.localDaemon },
    { key: "Connected Daemon", value: status.connectedDaemon },
    { key: "Home", value: status.home },
    { key: "Listen", value: status.listen },
    { key: "Hostname", value: status.hostname ?? "-" },
    { key: "PID", value: status.pid === null ? "-" : String(status.pid) },
    { key: "Started", value: status.startedAt ?? "-" },
    { key: "Owner", value: status.owner ?? "-" },
    { key: "Logs", value: status.logPath },
    { key: "Daemon Node", value: status.daemonNode },
    { key: "CLI Node", value: status.cliNode },
    { key: "CLI", value: status.cliVersion },
    { key: "Daemon Version", value: status.daemonVersion ?? "-" },
  ];

  if (status.runningAgents !== null && status.idleAgents !== null) {
    rows.push({
      key: "Agents",
      value: `${status.runningAgents} running, ${status.idleAgents} idle`,
    });
  } else {
    rows.push({
      key: "Agents",
      value: "Unavailable (daemon API not reachable)",
    });
  }

  if (status.note) {
    rows.push({ key: "Note", value: status.note });
  }

  rows.push({ key: "", value: "" });
  rows.push({ key: "Providers", value: "" });
  for (const provider of status.providers) {
    if (!provider.path) {
      rows.push({ key: `  ${provider.label}`, value: "not found" });
    } else if (!provider.version) {
      rows.push({ key: `  ${provider.label}`, value: `${provider.path} (--version failed)` });
    } else {
      rows.push({ key: `  ${provider.label}`, value: `${provider.path} (${provider.version})` });
    }
  }

  return rows;
}

const PROVIDER_BINARIES: { label: string; binary: string }[] = [
  { label: "Claude", binary: "claude" },
  { label: "Codex", binary: "codex" },
  { label: "OpenCode", binary: "opencode" },
];

async function checkProviderBinary(
  binary: string,
): Promise<{ path: string | null; version: string | null }> {
  const binaryPath = await findExecutable(binary);
  if (!binaryPath) {
    return { path: null, version: null };
  }
  const env = applyProviderEnv(process.env);
  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
      env,
      windowsHide: true,
    });
    return { path: binaryPath, version: stdout.trim() || null };
  } catch {
    return { path: binaryPath, version: null };
  }
}

async function checkProviderBinaries(): Promise<ProviderBinaryStatus[]> {
  const results = await Promise.all(
    PROVIDER_BINARIES.map(async ({ label, binary }) => {
      const result = await checkProviderBinary(binary);
      return { label, ...result };
    }),
  );
  return results;
}

function resolveOwnerLabel(uid: number | undefined, hostname: string | undefined): string | null {
  if (uid === undefined && !hostname) {
    return null;
  }
  const uidPart = uid === undefined ? "?" : String(uid);
  const hostPart = hostname ?? "unknown-host";
  return `${uidPart}@${hostPart}`;
}

export type StatusResult = ListResult<StatusRow>;

export async function runStatusCommand(
  options: CommandOptions,
  _command: Command,
): Promise<StatusResult> {
  const home = typeof options.home === "string" ? options.home : undefined;
  const state = resolveLocalDaemonState({ home });
  const host = resolveTcpHostFromListen(state.listen);

  const owner = resolveOwnerLabel(state.pidInfo?.uid, state.pidInfo?.hostname);
  let daemonNode: string;
  if (!state.running) {
    daemonNode = "-";
  } else if (state.pidInfo?.pid) {
    const fromPid = resolveNodePathFromPid(state.pidInfo.pid);
    daemonNode = fromPid.nodePath ?? `unknown (${fromPid.error ?? "could not resolve from PID"})`;
  } else {
    daemonNode = "unknown (no PID available)";
  }
  const cliNode = process.execPath;
  let localDaemon: DaemonStatus["localDaemon"] = state.running ? "running" : "stopped";
  let connectedDaemon: DaemonStatus["connectedDaemon"] = "not_probed";
  let runningAgents: number | null = null;
  let idleAgents: number | null = null;
  let daemonVersion: string | null = null;
  let note: string | undefined;

  if (!state.running && state.stalePidFile && state.pidInfo) {
    localDaemon = "stale_pid";
    note = `Stale PID file found for PID ${state.pidInfo.pid}`;
  }

  if (host) {
    const client = await tryConnectToDaemon({ host, timeout: 1500 });
    if (client) {
      connectedDaemon = "reachable";
      daemonVersion = client.getLastServerInfoMessage()?.version ?? null;
      try {
        const agentsPayload = await client.fetchAgents({ filter: { includeArchived: true } });
        const agents = agentsPayload.entries.map((entry) => entry.agent);
        runningAgents = agents.filter((a) => a.status === "running").length;
        idleAgents = agents.filter((a) => a.status === "idle").length;
        if (!state.running) {
          daemonNode = "unknown (API reachable, PID unresolved)";
          note = appendNote(
            note,
            state.pidInfo
              ? `Connected daemon is reachable at ${host} even though local daemon PID ${state.pidInfo.pid} is stale`
              : `Connected daemon is reachable at ${host} but no local daemon PID file was found`,
          );
        }
      } catch {
        if (state.running) {
          localDaemon = "unresponsive";
        }
        note = appendNote(
          note,
          state.running
            ? `Local daemon PID is running but API requests to ${host} failed`
            : `Connected daemon websocket is reachable at ${host} but fetch_agents failed`,
        );
      } finally {
        await client.close().catch(() => {});
      }
    } else if (state.running) {
      connectedDaemon = "unreachable";
      localDaemon = "unresponsive";
      note = appendNote(
        note,
        `Local daemon PID is running but websocket at ${host} is not reachable`,
      );
    } else {
      connectedDaemon = "unreachable";
    }
  } else {
    note = appendNote(note, "Daemon is configured for unix socket listen; API probe skipped");
  }

  const cliVersion = resolveCliVersion();

  let serverId: string | null = null;
  try {
    serverId = getOrCreateServerId(state.home);
  } catch (error) {
    note = appendNote(note, `serverId unavailable: ${shortenMessage(normalizeError(error))}`);
  }

  const providers = await checkProviderBinaries();

  const daemonStatus: DaemonStatus = {
    serverId,
    localDaemon,
    connectedDaemon,
    home: state.home,
    listen: state.listen,
    hostname: state.pidInfo?.hostname ?? null,
    pid: state.pidInfo?.pid ?? null,
    startedAt: state.pidInfo?.startedAt ?? null,
    owner,
    logPath: state.logPath,
    runningAgents,
    idleAgents,
    daemonNode,
    cliNode,
    cliVersion,
    daemonVersion,
    desktopManaged: state.pidInfo?.desktopManaged === true,
    providers,
    note,
  };

  return {
    type: "list",
    data: toStatusRows(daemonStatus),
    schema: createStatusSchema(daemonStatus),
  };
}
