import { type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain, powerMonitor } from "electron";
import log from "electron-log/main";
import { resolvePaseoHome, spawnProcess } from "@getpaseo/server";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
  writeAttachmentBytes,
} from "../features/attachments.js";
import {
  checkForAppUpdate,
  downloadAndInstallUpdate,
  type AppUpdateCheckIntent,
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import { getCliInstallStatus, installCli } from "../integrations/cli-install/index.js";
import {
  getSkillsStatus,
  installSkills,
  uninstallSkills,
  updateSkills,
} from "../integrations/skills/index.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";
import { runExternalCliJsonCommand, runExternalCliTextCommand } from "./cli/external.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";
import { getDesktopAppLogs } from "../diagnostics/app-logs.js";
import { tailFile } from "../diagnostics/tail-file.js";

const DAEMON_LOG_FILENAME = "daemon.log";
const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_MAX_ATTEMPTS = 150;
const DETACHED_STARTUP_GRACE_MS = 1200;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";
const DESKTOP_DAEMON_STOP_REASON_VALUES = [
  "manual_ipc",
  "settings",
  "host_remove",
  "quit",
  "app_update",
  "version_mismatch",
  "restart",
] as const;
export type DesktopDaemonStopReason = (typeof DESKTOP_DAEMON_STOP_REASON_VALUES)[number];

const DESKTOP_DAEMON_STOP_REASONS = new Set<string>(DESKTOP_DAEMON_STOP_REASON_VALUES);
const DEFAULT_DESKTOP_DAEMON_STOP_REASON: DesktopDaemonStopReason = "manual_ipc";

export interface DesktopDaemonStatus {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  error: string | null;
}

interface DesktopDaemonLogs {
  logPath: string;
  contents: string;
}

interface DesktopPairingOffer {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
}

function parseReleaseChannel(
  args: Record<string, unknown> | undefined,
): AppReleaseChannel | undefined {
  if (args?.releaseChannel === "beta") {
    return "beta";
  }
  if (args?.releaseChannel === "stable") {
    return "stable";
  }
  return undefined;
}

function parseAppUpdateCheckIntent(
  args: Record<string, unknown> | undefined,
): AppUpdateCheckIntent {
  return args?.intent === "manual" ? "manual" : "automatic";
}

function parseDesktopDaemonStopReason(
  args: Record<string, unknown> | undefined,
): DesktopDaemonStopReason {
  const reason = args?.reason;
  if (typeof reason === "string" && DESKTOP_DAEMON_STOP_REASONS.has(reason)) {
    return reason as DesktopDaemonStopReason;
  }
  return DEFAULT_DESKTOP_DAEMON_STOP_REASON;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome(process.env);
}

function logFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_LOG_FILENAME);
}

export function isDesktopManagedDaemonRunningSync(): boolean {
  try {
    const raw = readFileSync(path.join(getPaseoHome(), "paseo.pid"), "utf-8");
    const lock = JSON.parse(raw) as { pid?: unknown; desktopManaged?: unknown };
    if (lock.desktopManaged !== true) return false;
    if (typeof lock.pid !== "number" || !Number.isInteger(lock.pid)) return false;
    return isProcessRunning(lock.pid);
  } catch {
    return false;
  }
}

function summarizeDesktopDaemonStatus(status: DesktopDaemonStatus): Record<string, unknown> {
  return {
    status: status.status,
    pid: status.pid,
    listen: status.listen,
    serverId: status.serverId || null,
    version: status.version,
    desktopManaged: status.desktopManaged,
    error: status.error,
  };
}

const DESKTOP_DAEMON_STOP_CLI_ARGS = [
  "daemon",
  "stop",
  "--json",
  "--timeout",
  "5",
  "--force",
  "--kill-timeout",
  "5",
];

async function runDesktopDaemonStopViaCli({
  reason,
  statusBefore,
  resolveStatusAfter = false,
}: {
  reason: DesktopDaemonStopReason;
  statusBefore?: DesktopDaemonStatus | null;
  resolveStatusAfter?: boolean;
}): Promise<{
  cliResult: unknown;
  statusAfter: DesktopDaemonStatus | null;
}> {
  logDesktopDaemonLifecycle("desktop daemon stop requested", {
    reason,
    statusBefore: statusBefore ? summarizeDesktopDaemonStatus(statusBefore) : null,
  });

  const cliResult = await runExternalCliJsonCommand(DESKTOP_DAEMON_STOP_CLI_ARGS);
  const statusAfter = resolveStatusAfter ? await resolveDesktopDaemonStatus() : null;

  logDesktopDaemonLifecycle("desktop daemon stop completed", {
    reason,
    cliResult,
    statusAfter: statusAfter ? summarizeDesktopDaemonStatus(statusAfter) : null,
  });

  return { cliResult, statusAfter };
}

export async function stopDesktopDaemonViaCli(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<void> {
  await runDesktopDaemonStopViaCli({ reason });
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err && err.code === "EPERM") {
      return true;
    }
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logDesktopDaemonLifecycle(message: string, details?: Record<string, unknown>): void {
  log.info("[desktop daemon]", message, {
    pid: process.pid,
    ...details,
  });
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveDesktopAppVersion(): string {
  if (app.isPackaged) {
    return app.getVersion();
  }

  try {
    const packageJsonPath = path.join(__dirname, "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
      version?: unknown;
    };
    if (typeof pkg.version === "string" && pkg.version.trim().length > 0) {
      return pkg.version.trim();
    }
  } catch {
    // Fall back to Electron's default version if the package metadata is unavailable.
  }

  return app.getVersion();
}

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

export async function resolveDesktopDaemonStatus(): Promise<DesktopDaemonStatus> {
  const home = getPaseoHome();

  try {
    const payload = (await runExternalCliJsonCommand(["daemon", "status", "--json"])) as Record<
      string,
      unknown
    >;
    const localDaemon = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
    const connectedDaemon =
      typeof payload.connectedDaemon === "string" ? payload.connectedDaemon : "not_probed";
    const hasRunningLocalProcess = localDaemon === "running";
    const hasLocalProcess = hasRunningLocalProcess || localDaemon === "unresponsive";
    const desktopManaged = payload.desktopManaged === true;
    const apiReachable = connectedDaemon === "reachable";
    let status: DesktopDaemonState = "stopped";
    if (apiReachable || hasRunningLocalProcess) {
      status = "running";
    } else if (localDaemon === "unresponsive") {
      status = "errored";
    }

    return {
      serverId: typeof payload.serverId === "string" ? payload.serverId : "",
      status,
      listen: typeof payload.listen === "string" ? payload.listen : null,
      hostname:
        status === "running" && typeof payload.hostname === "string" ? payload.hostname : null,
      pid: hasLocalProcess && typeof payload.pid === "number" ? payload.pid : null,
      home,
      version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
      desktopManaged,
      error: null,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logDesktopDaemonLifecycle("resolveStatus CLI command failed", { error: errorMessage });
    return {
      serverId: "",
      status: "stopped",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      error: errorMessage,
    };
  }
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

function shouldRestartForVersion(current: DesktopDaemonStatus): boolean {
  if (!current.desktopManaged) return false;
  const appVersion = normalizeVersion(resolveDesktopAppVersion());
  const daemonVersion = normalizeVersion(current.version);
  return Boolean(appVersion && daemonVersion && appVersion !== daemonVersion);
}

function assertBuiltInDaemonManagementEnabled(settings: DesktopSettings): void {
  if (!settings.daemon.manageBuiltInDaemon) {
    throw new Error("Built-in daemon management is disabled.");
  }
}

function buildStartupFailureError(result: {
  code: number | null;
  signal: string | null;
  error?: Error;
}): Error {
  const reason = result.error
    ? result.error.message
    : `exit code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
  const parts = [`Daemon failed to start: ${reason}`];
  const logs = tailFile(logFilePath(), 15);
  if (logs) parts.push(`Recent logs (${logFilePath()}):\n${logs}`);
  return new Error(parts.join("\n\n"));
}

async function pollForRunningDaemon(): Promise<DesktopDaemonStatus> {
  async function poll(attempt: number): Promise<DesktopDaemonStatus> {
    if (attempt >= STARTUP_POLL_MAX_ATTEMPTS) return resolveDesktopDaemonStatus();
    const status = await resolveDesktopDaemonStatus();
    if (attempt === 0 || attempt === STARTUP_POLL_MAX_ATTEMPTS - 1 || attempt % 10 === 9) {
      logDesktopDaemonLifecycle("polling daemon status after detached start", {
        attempt: attempt + 1,
        status: status.status,
        pid: status.pid,
        listen: status.listen,
        serverId: status.serverId || null,
      });
    }
    if (status.status === "running" && status.serverId && status.listen) return status;
    await sleep(STARTUP_POLL_INTERVAL_MS);
    return poll(attempt + 1);
  }
  return poll(0);
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());

  const current = await resolveDesktopDaemonStatus();
  logDesktopDaemonLifecycle("initial status check before start", {
    status: current.status,
    pid: current.pid,
    listen: current.listen,
    serverId: current.serverId || null,
    error: current.error,
    desktopManaged: current.desktopManaged,
  });
  if (current.status === "running") {
    if (shouldRestartForVersion(current)) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion: normalizeVersion(resolveDesktopAppVersion()),
        daemonVersion: normalizeVersion(current.version),
      });
      await stopDesktopDaemon("version_mismatch");
    } else {
      return current;
    }
  }

  const daemonRunner = resolveDaemonRunnerEntrypoint();
  const reclaimStalePidLock =
    current.status === "errored" && current.desktopManaged && current.error === null;
  const invocation = createNodeEntrypointInvocation({
    entrypoint: daemonRunner,
    argvMode: "node-script",
    args: reclaimStalePidLock ? ["--reclaim-stale-pid-lock"] : [],
    baseEnv: process.env,
  });

  logDesktopDaemonLifecycle("starting detached daemon", {
    appIsPackaged: app.isPackaged,
    daemonRunnerEntry: daemonRunner.entryPath,
    daemonRunnerExecArgv: daemonRunner.execArgv,
    command: invocation.command,
    args: invocation.args,
    electronRunAsNode: invocation.env.ELECTRON_RUN_AS_NODE ?? null,
    parentExecPath: process.execPath,
    parentElectronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
    electronVersion: process.versions.electron ?? null,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  });

  const child: ChildProcess = spawnProcess(invocation.command, invocation.args, {
    detached: true,
    envMode: "internal",
    env: invocation.env,
    envOverlay: { PASEO_DESKTOP_MANAGED: "1", PASEO_WEB_UI_ENABLED: "false" },
    stdio: ["ignore", "ignore", "ignore"],
  });

  logDesktopDaemonLifecycle("detached spawn returned", {
    childPid: child.pid ?? null,
    spawnfile: child.spawnfile,
    spawnargs: child.spawnargs,
  });

  child.unref();

  type GraceResult =
    | { exitedEarly: false }
    | { exitedEarly: true; code: number | null; signal: string | null; error?: Error };

  const result = await new Promise<GraceResult>((resolve) => {
    let settled = false;
    const finish = (value: GraceResult) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish({ exitedEarly: false }), DETACHED_STARTUP_GRACE_MS);

    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      finish({ exitedEarly: true, code, signal });
    });
  });

  logDesktopDaemonLifecycle("detached startup grace period completed", {
    childPid: child.pid ?? null,
    exitedEarly: result.exitedEarly,
    ...(result.exitedEarly
      ? {
          exitCode: result.code,
          signal: result.signal,
          error: result.error?.message ?? null,
        }
      : {}),
  });

  if (result.exitedEarly) {
    throw buildStartupFailureError(result);
  }

  return pollForRunningDaemon();
}

export async function stopDesktopDaemon(
  reason: DesktopDaemonStopReason = DEFAULT_DESKTOP_DAEMON_STOP_REASON,
): Promise<DesktopDaemonStatus> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    logDesktopDaemonLifecycle("desktop daemon stop skipped", {
      reason,
      statusBefore: summarizeDesktopDaemonStatus(status),
    });
    return status;
  }

  const { statusAfter } = await runDesktopDaemonStopViaCli({
    reason,
    statusBefore: status,
    resolveStatusAfter: true,
  });
  return statusAfter ?? (await resolveDesktopDaemonStatus());
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  await stopDesktopDaemon("restart");
  return startDaemon();
}

function getDaemonLogs(): DesktopDaemonLogs {
  const logPath = logFilePath();
  return {
    logPath,
    contents: tailFile(logPath, 100),
  };
}

async function getCliDaemonStatus(): Promise<string> {
  return await runExternalCliTextCommand(["daemon", "status"]);
}

async function getDaemonPairing(): Promise<DesktopPairingOffer> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return {
      relayEnabled: false,
      url: null,
      qr: null,
    };
  }

  try {
    const payload = await runExternalCliJsonCommand(["daemon", "pair", "--json"]);
    if (!isRecord(payload)) {
      throw new Error("Daemon pairing response was not an object.");
    }

    return {
      relayEnabled: payload.relayEnabled === true,
      url: toTrimmedString(payload.url),
      qr: toTrimmedString(payload.qr),
    };
  } catch {
    return {
      relayEnabled: false,
      url: null,
      qr: null,
    };
  }
}

async function getLocalDaemonVersion(): Promise<{ version: string | null; error: string | null }> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

async function resolveRequestedReleaseChannel(
  args: Record<string, unknown> | undefined,
): Promise<AppReleaseChannel> {
  return parseReleaseChannel(args) ?? (await getDesktopSettingsStore().get()).releaseChannel;
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    ...createDesktopSettingsCommandHandlers({ settingsStore: getDesktopSettingsStore() }),
    desktop_get_runtime_info: () => ({
      appVersion: resolveDesktopAppVersion(),
      runningUnderARM64Translation: isRunningUnderARM64Translation(),
    }),
    desktop_daemon_status: () => resolveDesktopDaemonStatus(),
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: (args) => stopDesktopDaemon(parseDesktopDaemonStopReason(args)),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_app_logs: () => getDesktopAppLogs(),
    desktop_daemon_pairing: () => getDaemonPairing(),
    desktop_get_system_idle_time: () => powerMonitor.getSystemIdleTime() * 1000,
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
    write_attachment_bytes: (args) => writeAttachmentBytes(args ?? {}),
    copy_attachment_file: (args) => copyAttachmentFileToManagedStorage(args ?? {}),
    read_file_base64: (args) => readManagedFileBase64(args ?? {}),
    delete_attachment_file: (args) => deleteManagedAttachmentFile(args ?? {}),
    garbage_collect_attachment_files: (args) => garbageCollectManagedAttachmentFiles(args ?? {}),
    open_local_daemon_transport: async (args) => {
      const target = args as { transportType: "socket" | "pipe"; transportPath: string };
      return await openLocalTransportSession(target);
    },
    send_local_daemon_transport_message: async (args) => {
      await sendLocalTransportMessage(
        args as { sessionId: string; text?: string; binaryBase64?: string },
      );
    },
    close_local_daemon_transport: (args) => {
      const sessionId =
        typeof args === "object" && args !== null && "sessionId" in args
          ? (args as { sessionId: string }).sessionId
          : "";
      if (sessionId) closeLocalTransportSession(sessionId);
    },
    check_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return checkForAppUpdate({
        currentVersion,
        releaseChannel: await resolveRequestedReleaseChannel(args),
        intent: parseAppUpdateCheckIntent(args),
      });
    },
    install_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return downloadAndInstallUpdate(
        { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
        async () => {
          await stopDesktopDaemon("app_update");
        },
      );
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    get_skills_status: () => getSkillsStatus(),
    install_skills: () => installSkills(),
    update_skills: () => updateSkills(),
    uninstall_skills: () => uninstallSkills(),
  };
}

export function registerDaemonManager(): void {
  const handlers = createDaemonCommandHandlers();

  ipcMain.handle(
    "paseo:invoke",
    async (_event, command: string, args?: Record<string, unknown>) => {
      const handler = handlers[command];
      if (!handler) {
        throw new Error(`Unknown desktop command: ${command}`);
      }
      return await handler(args);
    },
  );
}
