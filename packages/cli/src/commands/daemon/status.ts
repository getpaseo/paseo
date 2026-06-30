import type { Command } from "commander";
import { createRequire } from "node:module";
import { getOrCreateServerId, findExecutable, execCommand } from "@getpaseo/server";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, ListResult, OutputSchema } from "../../output/index.js";
import { resolveLocalDaemonState, resolveTcpHostFromListen } from "./local-daemon.js";
import { resolveNodePathFromPid } from "./runtime-toolchain.js";

const DAEMON_STATUS_PROBE_TIMEOUT_MS = 1500;

interface ProviderBinaryStatus {
  label: string;
  path: string | null;
  version: string | null;
  source?: "daemon" | "local";
}

interface DaemonStatus {
  serverId: string | null;
  localDaemon: "running" | "stopped" | "stale_pid" | "unresponsive";
  connectedDaemon: "reachable" | "unreachable" | "auth_required" | "auth_failed" | "not_probed";
  home: string;
  listen: string;
  relay: string;
  hostname: string | null;
  pid: number | null;
  startedAt: string | null;
  owner: string | null;
  logPath: string;
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

interface CliPackageJson {
  version?: unknown;
}

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
            if (item.value === "not_probed" || item.value === "auth_required") return "yellow";
            return "red";
          }
          if (item.key.startsWith("  ")) {
            if (item.value === "not found" || item.value === "not found (daemon)") return "red";
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
    { key: "Relay", value: status.relay },
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

  if (status.note) {
    rows.push({ key: "Note", value: status.note });
  }

  rows.push({ key: "", value: "" });
  rows.push({ key: "Providers", value: "" });
  for (const provider of status.providers) {
    if (provider.source === "daemon") {
      if (!provider.path) {
        rows.push({ key: `  ${provider.label}`, value: "not found (daemon)" });
      } else {
        rows.push({ key: `  ${provider.label}`, value: `${provider.path} (daemon)` });
      }
    } else if (!provider.path) {
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
  try {
    const { stdout } = await execCommand(binaryPath, ["--version"], {
      timeout: 5000,
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
      return Object.assign({ label }, result);
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

interface DaemonProbeResult {
  connectedDaemon: DaemonStatus["connectedDaemon"];
  localDaemonOverride?: DaemonStatus["localDaemon"];
  daemonVersion?: string | null;
  daemonNodeOverride?: string;
  daemonProviders?: ProviderBinaryStatus[];
  note?: string;
}

type DaemonAuthProbeFailure = "auth_required" | "auth_failed";

function classifyDaemonAuthProbeFailure(error: unknown): DaemonAuthProbeFailure | null {
  if (!(error instanceof Error)) return null;
  if (error.message === "Password required") return "auth_required";
  if (error.message === "Incorrect password") return "auth_failed";
  return null;
}

function describeDaemonAuthProbeFailure(host: string, failure: DaemonAuthProbeFailure): string {
  if (failure === "auth_required") {
    return `Daemon is reachable at ${host} but requires a password. Set PASEO_PASSWORD and retry.`;
  }
  return `Daemon is reachable at ${host} but the supplied password was rejected. Check PASEO_PASSWORD and retry.`;
}

async function probeDaemonOverWebsocket(args: {
  host: string;
  state: ReturnType<typeof resolveLocalDaemonState>;
}): Promise<DaemonProbeResult> {
  const { host, state } = args;
  let client: Awaited<ReturnType<typeof connectToDaemon>>;
  try {
    client = await connectToDaemon({ host, timeout: 1500 });
  } catch (error) {
    const authFailure = classifyDaemonAuthProbeFailure(error);
    if (authFailure) {
      return {
        connectedDaemon: authFailure,
        note: describeDaemonAuthProbeFailure(host, authFailure),
      };
    }

    if (state.running) {
      return {
        connectedDaemon: "unreachable",
        localDaemonOverride: "unresponsive",
        note: `Local daemon PID is running but websocket at ${host} is not reachable`,
      };
    }
    return { connectedDaemon: "unreachable" };
  }

  const daemonVersion = client.getLastServerInfoMessage()?.version ?? null;
  try {
    const statusPayload = await client.getDaemonStatus({
      timeout: DAEMON_STATUS_PROBE_TIMEOUT_MS,
    });
    const labelMap = new Map(PROVIDER_BINARIES.map((p) => [p.binary, p.label]));
    const daemonProviders = statusPayload.providers.map((p) => ({
      label: labelMap.get(p.provider) ?? p.provider,
      path: p.available ? "available" : null,
      version: p.available ? null : (p.error ?? null),
      source: "daemon" as const,
    }));

    if (!state.running) {
      return {
        connectedDaemon: "reachable",
        daemonVersion: statusPayload.version ?? daemonVersion,
        daemonNodeOverride: statusPayload.nodePath,
        daemonProviders,
        note: state.pidInfo
          ? `Connected daemon is reachable at ${host} even though local daemon PID ${state.pidInfo.pid} is stale`
          : `Connected daemon is reachable at ${host} but no local daemon PID file was found`,
      };
    }

    return {
      connectedDaemon: "reachable",
      daemonVersion: statusPayload.version ?? daemonVersion,
      daemonNodeOverride: statusPayload.nodePath,
      daemonProviders,
    };
  } catch {
    return {
      connectedDaemon: "reachable",
      daemonVersion,
      note: state.running
        ? `Local daemon PID is running but daemon detail request to ${host} failed`
        : `Connected daemon websocket is reachable at ${host} but daemon status request failed`,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

interface ProbeMergeState {
  probe: DaemonProbeResult;
  connectedDaemon: DaemonStatus["connectedDaemon"];
  localDaemon: DaemonStatus["localDaemon"];
  daemonNode: string;
  daemonVersion: string | null;
  daemonProviders: ProviderBinaryStatus[] | undefined;
  note: string | undefined;
}

function applyProbeToStatus(input: ProbeMergeState): Omit<ProbeMergeState, "probe"> {
  const { probe } = input;
  return {
    connectedDaemon: probe.connectedDaemon,
    localDaemon: probe.localDaemonOverride ?? input.localDaemon,
    daemonNode: probe.daemonNodeOverride ?? input.daemonNode,
    daemonVersion: probe.daemonVersion !== undefined ? probe.daemonVersion : input.daemonVersion,
    daemonProviders: probe.daemonProviders ?? input.daemonProviders,
    note: probe.note ? appendNote(input.note, probe.note) : input.note,
  };
}

function resolveServerIdSafely(home: string): { serverId: string | null; error: string | null } {
  try {
    return { serverId: getOrCreateServerId(home), error: null };
  } catch (error) {
    return {
      serverId: null,
      error: `serverId unavailable: ${shortenMessage(normalizeError(error))}`,
    };
  }
}

async function resolveDaemonNodeLabel(
  state: ReturnType<typeof resolveLocalDaemonState>,
): Promise<string> {
  if (!state.running) return "-";
  if (!state.pidInfo?.pid) return "unknown (no PID available)";
  const fromPid = await resolveNodePathFromPid(state.pidInfo.pid);
  return fromPid.nodePath ?? `unknown (${fromPid.error ?? "could not resolve from PID"})`;
}

function formatRelayStatus(state: ReturnType<typeof resolveLocalDaemonState>): string {
  if (!state.relayEnabled) return "disabled";
  const scheme = state.relayPublicUseTls ? "wss" : "ws";
  return `${scheme}://${state.relayEndpoint}`;
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
  let daemonNode = await resolveDaemonNodeLabel(state);
  const cliNode = process.execPath;
  let localDaemon: DaemonStatus["localDaemon"] = state.running ? "running" : "stopped";
  let connectedDaemon: DaemonStatus["connectedDaemon"] = "not_probed";
  let daemonVersion: string | null = null;
  let daemonProviders: ProviderBinaryStatus[] | undefined;
  let note: string | undefined;

  if (!state.running && state.stalePidFile && state.pidInfo) {
    localDaemon = "stale_pid";
    note = `Stale PID file found for PID ${state.pidInfo.pid}`;
  }

  if (host) {
    const probe = await probeDaemonOverWebsocket({ host, state });
    ({ connectedDaemon, localDaemon, daemonNode, daemonVersion, daemonProviders, note } =
      applyProbeToStatus({
        probe,
        connectedDaemon,
        localDaemon,
        daemonNode,
        daemonVersion,
        daemonProviders,
        note,
      }));
  } else {
    note = appendNote(note, "Daemon is configured for unix socket listen; API probe skipped");
  }

  const cliVersion = resolveCliVersion();

  const serverIdResult = resolveServerIdSafely(state.home);
  const serverId = serverIdResult.serverId;
  if (serverIdResult.error) {
    note = appendNote(note, serverIdResult.error);
  }

  const providers = daemonProviders ?? (await checkProviderBinaries());

  const daemonStatus: DaemonStatus = {
    serverId,
    localDaemon,
    connectedDaemon,
    home: state.home,
    listen: state.listen,
    relay: formatRelayStatus(state),
    hostname: state.pidInfo?.hostname ?? null,
    pid: state.pidInfo?.pid ?? null,
    startedAt: state.pidInfo?.startedAt ?? null,
    owner,
    logPath: state.logPath,
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
