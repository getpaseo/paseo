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
  type AppReleaseChannel,
} from "../features/auto-updater.js";
import {
  installCli,
  getCliInstallStatus,
  installSkills,
  getSkillsInstallStatus,
} from "../integrations/integrations-manager.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import {
  createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint,
  runCliJsonCommand,
  runCliTextCommand,
} from "./runtime-paths.js";
import {
  createDesktopSettingsCommandHandlers,
  type DesktopCommandHandler,
} from "../settings/desktop-settings-commands.js";
import type { DesktopSettings } from "../settings/desktop-settings.js";
import { getDesktopSettingsStore } from "../settings/desktop-settings-electron.js";
import { isRunningUnderARM64Translation } from "../system/arm64-translation.js";

const DAEMON_LOG_FILENAME = "daemon.log";
const PID_POLL_INTERVAL_MS = 100;
const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_MAX_ATTEMPTS = 150;
const STOP_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 3_000;
const DETACHED_STARTUP_GRACE_MS = 1200;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";

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

export async function stopDesktopDaemonViaCli(): Promise<void> {
  await runCliJsonCommand([
    "daemon",
    "stop",
    "--json",
    "--timeout",
    "5",
    "--force",
    "--kill-timeout",
    "5",
  ]);
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

function signalProcessSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err) {
      if (err.code === "ESRCH") return false;
      if (err.code === "EPERM") return true;
    }
    throw err;
  }
}

function signalProcessGroupSafely(pid: number, signal: NodeJS.Signals): boolean {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  if (process.platform === "win32") return signalProcessSafely(pid, signal);
  try {
    process.kill(-pid, signal);
    return true;
  } catch (err) {
    if (typeof err === "object" && err !== null && "code" in err) {
      if (err.code === "ESRCH") return signalProcessSafely(pid, signal);
      if (err.code === "EPERM") return true;
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  async function poll(): Promise<boolean> {
    if (!isProcessRunning(pid)) return true;
    if (Date.now() >= deadline) return !isProcessRunning(pid);
    await sleep(PID_POLL_INTERVAL_MS);
    return poll();
  }
  return poll();
}

function tailFile(filePath: string, lines = 50): string {
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter(Boolean).slice(-lines).join("\n");
  } catch {
    return "";
  }
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
    const payload = (await runCliJsonCommand(["daemon", "status", "--json"])) as Record<
      string,
      unknown
    >;
    const localDaemon = typeof payload.localDaemon === "string" ? payload.localDaemon : "stopped";
    const running = localDaemon === "running";

    return {
      serverId: typeof payload.serverId === "string" ? payload.serverId : "",
      status: running ? "running" : "stopped",
      listen: typeof payload.listen === "string" ? payload.listen : null,
      hostname: running && typeof payload.hostname === "string" ? payload.hostname : null,
      pid: running && typeof payload.pid === "number" ? payload.pid : null,
      home,
      version: typeof payload.daemonVersion === "string" ? payload.daemonVersion : null,
      desktopManaged: payload.desktopManaged === true,
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

function buildStartupFailureError(
  result: { code: number | null; signal: string | null; error?: Error },
  stdout: string,
  stderr: string,
): Error {
  const reason = result.error
    ? result.error.message
    : `exit code ${result.code ?? "unknown"}${result.signal ? ` (${result.signal})` : ""}`;
  const parts = [`Daemon failed to start: ${reason}`];
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
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
      await stopDesktopDaemon();
    } else {
      return current;
    }
  }

  const daemonRunner = resolveDaemonRunnerEntrypoint();
  const invocation = createNodeEntrypointInvocation({
    entrypoint: daemonRunner,
    argvMode: "node-script",
    args: [],
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
    envOverlay: { PASEO_DESKTOP_MANAGED: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr!.on("data", (data: Buffer) => {
    stderr += data.toString();
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
    stdout: stdout.slice(0, 2000),
    stderr: stderr.slice(0, 2000),
    ...(result.exitedEarly
      ? {
          exitCode: result.code,
          signal: result.signal,
          error: result.error?.message ?? null,
        }
      : {}),
  });

  if (result.exitedEarly) {
    throw buildStartupFailureError(result, stdout, stderr);
  }

  return pollForRunningDaemon();
}

export async function stopDesktopDaemon(): Promise<DesktopDaemonStatus> {
  const status = await resolveDesktopDaemonStatus();
  if (status.status !== "running" || !status.pid) return status;

  const pid = status.pid;
  signalProcessSafely(pid, "SIGTERM");

  let stopped = await waitForPidExit(pid, STOP_TIMEOUT_MS);
  if (!stopped) {
    signalProcessGroupSafely(pid, "SIGKILL");
    stopped = await waitForPidExit(pid, KILL_TIMEOUT_MS);
  }

  if (!stopped) {
    throw new Error(`Timed out waiting for daemon PID ${pid} to stop`);
  }

  return await resolveDesktopDaemonStatus();
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  assertBuiltInDaemonManagementEnabled(await getDesktopSettingsStore().get());
  await stopDesktopDaemon();
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
  return await runCliTextCommand(["daemon", "status"]);
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
    const payload = await runCliJsonCommand(["daemon", "pair", "--json"]);
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
    stop_desktop_daemon: () => stopDesktopDaemon(),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
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
      });
    },
    install_app_update: async (args) => {
      const currentVersion = resolveDesktopAppVersion();
      return downloadAndInstallUpdate(
        { currentVersion, releaseChannel: await resolveRequestedReleaseChannel(args) },
        async () => {
          await stopDesktopDaemon();
        },
      );
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    install_cli: () => installCli(),
    get_cli_install_status: () => getCliInstallStatus(),
    install_skills: () => installSkills(),
    get_skills_install_status: () => getSkillsInstallStatus(),
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
