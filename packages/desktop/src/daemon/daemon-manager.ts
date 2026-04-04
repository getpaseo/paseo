import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import log from "electron-log/main";
import { resolvePaseoHome } from "@getpaseo/server";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
} from "../features/attachments.js";
import { checkForAppUpdate, downloadAndInstallUpdate } from "../features/auto-updater.js";
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

const DAEMON_LOG_FILENAME = "daemon.log";
const PID_POLL_INTERVAL_MS = 100;
const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_MAX_ATTEMPTS = 150;
const STOP_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 3_000;
const DETACHED_STARTUP_GRACE_MS = 1200;

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";

type DesktopDaemonStatus = {
  serverId: string;
  status: DesktopDaemonState;
  listen: string | null;
  hostname: string | null;
  pid: number | null;
  home: string;
  version: string | null;
  desktopManaged: boolean;
  error: string | null;
};

type DesktopDaemonLogs = {
  logPath: string;
  contents: string;
};

type DesktopPairingOffer = {
  relayEnabled: boolean;
  url: string | null;
  qr: string | null;
};

type DesktopCommandHandler = (args?: Record<string, unknown>) => Promise<unknown> | unknown;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome(process.env);
}

function logFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_LOG_FILENAME);
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
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true;
    await sleep(PID_POLL_INTERVAL_MS);
  }
  return !isProcessRunning(pid);
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
    ...(details ?? {}),
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

async function resolveStatus(): Promise<DesktopDaemonStatus> {
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
    return {
      serverId: "",
      status: "stopped",
      listen: null,
      hostname: null,
      pid: null,
      home,
      version: null,
      desktopManaged: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeVersion(version: string | null): string | null {
  const trimmed = version?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v/i, "");
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  const current = await resolveStatus();
  if (current.status === "running") {
    const appVersion = normalizeVersion(resolveDesktopAppVersion());
    const daemonVersion = normalizeVersion(current.version);
    if (
      current.desktopManaged &&
      appVersion &&
      daemonVersion &&
      appVersion !== daemonVersion
    ) {
      logDesktopDaemonLifecycle("daemon version mismatch, restarting", {
        appVersion,
        daemonVersion,
      });
      await stopDaemon();
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
  });

  const child: ChildProcess = spawn(
    invocation.command,
    invocation.args,
    {
      detached: true,
      env: { ...invocation.env, PASEO_DESKTOP_MANAGED: "1" },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );

  logDesktopDaemonLifecycle("detached spawn returned", {
    childPid: child.pid ?? null,
    spawnfile: child.spawnfile,
    spawnargs: child.spawnargs,
  });

  child.unref();

  // Wait for process to survive the grace period
  const exitedEarly = await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const timer = setTimeout(() => finish(false), DETACHED_STARTUP_GRACE_MS);

    child.once("error", () => {
      logDesktopDaemonLifecycle("detached child emitted error during grace period", {
        childPid: child.pid ?? null,
      });
      clearTimeout(timer);
      finish(true);
    });
    child.once("exit", () => {
      logDesktopDaemonLifecycle("detached child emitted exit during grace period", {
        childPid: child.pid ?? null,
      });
      clearTimeout(timer);
      finish(true);
    });
  });

  logDesktopDaemonLifecycle("detached startup grace period completed", {
    childPid: child.pid ?? null,
    exitedEarly,
  });

  if (exitedEarly) {
    const logs = tailFile(logFilePath(), 15);
    throw new Error(`Daemon failed to start.${logs ? `\n\nRecent logs:\n${logs}` : ""}`);
  }

  // Poll for PID file with server ID
  for (let attempt = 0; attempt < STARTUP_POLL_MAX_ATTEMPTS; attempt++) {
    const status = await resolveStatus();
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
  }

  return await resolveStatus();
}

async function stopDaemon(): Promise<DesktopDaemonStatus> {
  const status = await resolveStatus();
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

  return await resolveStatus();
}

async function restartDaemon(): Promise<DesktopDaemonStatus> {
  await stopDaemon();
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
  const status = await resolveStatus();
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
  const status = await resolveStatus();
  if (status.status !== "running") {
    return { version: null, error: "Daemon is not running." };
  }
  return {
    version: status.version,
    error: status.version ? null : "Running daemon did not report a version.",
  };
}

function resolveCurrentUpdateVersion(): string {
  return resolveDesktopAppVersion();
}

// ---------------------------------------------------------------------------
// IPC registration
// ---------------------------------------------------------------------------

export function createDaemonCommandHandlers(): Record<string, DesktopCommandHandler> {
  return {
    desktop_daemon_status: () => resolveStatus(),
    start_desktop_daemon: () => startDaemon(),
    stop_desktop_daemon: () => stopDaemon(),
    restart_desktop_daemon: () => restartDaemon(),
    desktop_daemon_logs: () => getDaemonLogs(),
    desktop_daemon_pairing: () => getDaemonPairing(),
    cli_daemon_status: () => getCliDaemonStatus(),
    write_attachment_base64: (args) => writeAttachmentBase64(args ?? {}),
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
    check_app_update: async () => {
      const currentVersion = await resolveCurrentUpdateVersion();
      return checkForAppUpdate(currentVersion);
    },
    install_app_update: async () => {
      const currentVersion = await resolveCurrentUpdateVersion();
      return downloadAndInstallUpdate(currentVersion, async () => {
        await stopDaemon();
      });
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
