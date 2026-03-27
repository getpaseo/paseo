import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { app, ipcMain } from "electron";
import { loadConfig, resolvePaseoHome, getOrCreateServerId } from "@getpaseo/server";
import {
  copyAttachmentFileToManagedStorage,
  deleteManagedAttachmentFile,
  garbageCollectManagedAttachmentFiles,
  readManagedFileBase64,
  writeAttachmentBase64,
} from "../features/attachments.js";
import { checkForAppUpdate, downloadAndInstallUpdate } from "../features/auto-updater.js";
import {
  openLocalTransportSession,
  sendLocalTransportMessage,
  closeLocalTransportSession,
} from "./local-transport.js";
import { createNodeEntrypointInvocation, resolveDaemonRunnerEntrypoint } from "./runtime-paths.js";

const DAEMON_LOG_FILENAME = "daemon.log";
const DAEMON_PID_FILENAME = "paseo.pid";
const PID_POLL_INTERVAL_MS = 100;
const STARTUP_POLL_INTERVAL_MS = 200;
const STARTUP_POLL_MAX_ATTEMPTS = 150;
const STOP_TIMEOUT_MS = 15_000;
const KILL_TIMEOUT_MS = 3_000;
const DETACHED_STARTUP_GRACE_MS = 1200;
const DEFAULT_ELECTRON_DEV_SERVER_URL = "http://localhost:8081";

type DesktopDaemonState = "starting" | "running" | "stopped" | "errored";

type DesktopDaemonStatus = {
  serverId: string;
  status: DesktopDaemonState;
  listen: string;
  hostname: string | null;
  pid: number | null;
  home: string;
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

type CliSymlinkInstructions = {
  title: string;
  detail: string;
  commands: string;
};

type DesktopCommandHandler = (args?: Record<string, unknown>) => Promise<unknown> | unknown;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getPaseoHome(): string {
  return resolvePaseoHome(process.env);
}

function pidFilePath(): string {
  return path.join(getPaseoHome(), DAEMON_PID_FILENAME);
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

function buildDesktopDaemonCorsOriginsEnv(): string | undefined {
  const origins = new Set(
    (process.env.PASEO_CORS_ORIGINS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0),
  );

  origins.add("paseo://app");

  const devServerUrl = process.env.EXPO_DEV_URL ?? DEFAULT_ELECTRON_DEV_SERVER_URL;
  try {
    const parsed = new URL(devServerUrl);
    origins.add(parsed.origin);

    if (parsed.hostname === "localhost") {
      origins.add(`${parsed.protocol}//127.0.0.1${parsed.port ? `:${parsed.port}` : ""}`);
    } else if (parsed.hostname === "127.0.0.1") {
      origins.add(`${parsed.protocol}//localhost${parsed.port ? `:${parsed.port}` : ""}`);
    }
  } catch {
    // Ignore malformed dev server URLs and preserve any explicit env configuration.
  }

  return origins.size > 0 ? Array.from(origins).join(",") : undefined;
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

function resolveTcpHostFromListen(listen: string): string | null {
  const normalized = listen.trim();
  if (!normalized) {
    return null;
  }

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("unix://") ||
    normalized.startsWith("pipe://") ||
    normalized.startsWith("\\\\.\\pipe\\") ||
    /^[A-Za-z]:[/\\]/.test(normalized)
  ) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    return `127.0.0.1:${normalized}`;
  }

  if (normalized.includes(":")) {
    return normalized;
  }

  return null;
}

function buildDaemonHttpBaseUrl(listen: string): string | null {
  const endpoint = resolveTcpHostFromListen(listen);
  if (!endpoint) {
    return null;
  }
  return new URL(`http://${endpoint}`).toString().replace(/\/$/, "");
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

function resolveStatus(): DesktopDaemonStatus {
  const home = getPaseoHome();
  const config = loadConfig(home, { env: process.env });
  const pidPath = pidFilePath();

  let pid: number | null = null;
  let hostname: string | null = null;
  let listen: string = config.listen;

  try {
    if (existsSync(pidPath)) {
      const parsed = JSON.parse(readFileSync(pidPath, "utf-8")) as Record<string, unknown>;
      const pidValue = parsed.pid;
      if (typeof pidValue === "number" && Number.isInteger(pidValue) && pidValue > 0) {
        pid = pidValue;
        hostname = typeof parsed.hostname === "string" ? parsed.hostname : null;
        const pidListen =
          typeof parsed.listen === "string"
            ? parsed.listen
            : typeof parsed.sockPath === "string"
              ? (parsed.sockPath as string)
              : null;
        if (pidListen) listen = pidListen;
      }
    }
  } catch {
    // PID file missing or malformed — treat as stopped.
  }

  const running = pid !== null && isProcessRunning(pid);

  let serverId = "";
  try {
    serverId = getOrCreateServerId(home);
  } catch {
    // Ignore — server-id may not exist yet.
  }

  return {
    serverId,
    status: running ? "running" : "stopped",
    listen,
    hostname: running ? hostname : null,
    pid: running ? pid : null,
    home,
    error: null,
  };
}

async function startDaemon(): Promise<DesktopDaemonStatus> {
  const current = resolveStatus();
  if (current.status === "running") return current;

  const home = getPaseoHome();
  const daemonRunner = resolveDaemonRunnerEntrypoint();
  const corsOrigins = buildDesktopDaemonCorsOriginsEnv();
  const invocation = createNodeEntrypointInvocation({
    entrypoint: daemonRunner,
    argvMode: "node-script",
    args: [],
    baseEnv: {
      ...process.env,
      PASEO_HOME: home,
      ...(corsOrigins ? { PASEO_CORS_ORIGINS: corsOrigins } : {}),
    },
  });

  const child: ChildProcess = spawn(
    invocation.command,
    invocation.args,
    {
      detached: true,
      env: invocation.env,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );

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
      clearTimeout(timer);
      finish(true);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      finish(true);
    });
  });

  if (exitedEarly) {
    const logs = tailFile(logFilePath(), 15);
    throw new Error(`Daemon failed to start.${logs ? `\n\nRecent logs:\n${logs}` : ""}`);
  }

  // Poll for PID file with server ID
  for (let attempt = 0; attempt < STARTUP_POLL_MAX_ATTEMPTS; attempt++) {
    const status = resolveStatus();
    if (status.status === "running" && status.serverId) return status;
    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  return resolveStatus();
}

async function stopDaemon(): Promise<DesktopDaemonStatus> {
  const status = resolveStatus();
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

  return resolveStatus();
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

async function getDaemonPairing(): Promise<DesktopPairingOffer> {
  const status = resolveStatus();
  if (status.status !== "running") {
    return {
      relayEnabled: false,
      url: null,
      qr: null,
    };
  }

  try {
    const baseUrl = buildDaemonHttpBaseUrl(status.listen);
    if (!baseUrl) {
      throw new Error(`Daemon listen target is not a TCP endpoint: ${status.listen}`);
    }

    const response = await fetch(`${baseUrl}/pairing`);
    if (!response.ok) {
      throw new Error(`Daemon pairing request failed with ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
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

async function getLocalDaemonVersion(): Promise<{
  version: string | null;
  error: string | null;
}> {
  const status = resolveStatus();
  if (status.status !== "running") {
    return {
      version: null,
      error: "Daemon is not running.",
    };
  }

  const baseUrl = buildDaemonHttpBaseUrl(status.listen);
  if (!baseUrl) {
    return { version: null, error: `Daemon listen target is not a TCP endpoint: ${status.listen}` };
  }

  try {
    const response = await fetch(`${baseUrl}/api/status`);
    if (!response.ok) {
      return { version: null, error: `Daemon status request failed with ${response.status}` };
    }
    const payload = (await response.json()) as Record<string, unknown>;
    const version = typeof payload.version === "string" ? payload.version.trim() : null;
    return {
      version: version && version.length > 0 ? version : null,
      error: version ? null : "Running daemon did not report a version.",
    };
  } catch (error) {
    return {
      version: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveCurrentUpdateVersion(): Promise<string> {
  const daemonVersion = await getLocalDaemonVersion();
  if (daemonVersion.version) {
    return daemonVersion.version;
  }
  return resolveDesktopAppVersion();
}

function getCliSymlinkInstructions(): CliSymlinkInstructions {
  const electronExePath = app.getPath("exe");
  const cliShimFilename = process.platform === "win32" ? "paseo.cmd" : "paseo";

  if (process.platform === "darwin") {
    const appBundle = electronExePath.replace(/\/Contents\/MacOS\/.+$/, "");
    const cliPath = path.join(appBundle, "Contents", "Resources", "bin", cliShimFilename);
    return {
      title: "Add paseo to your shell",
      detail: "Create a symlink to the bundled Paseo CLI shim.",
      commands: `sudo ln -sf "${cliPath}" /usr/local/bin/paseo`,
    };
  }

  if (process.platform === "win32") {
    const cliPath = path.join(path.dirname(electronExePath), "resources", "bin", cliShimFilename);
    return {
      title: "Add paseo to your PATH",
      detail: "Add the Paseo installation directory to your system PATH so paseo.cmd is available.",
      commands: `setx PATH "%PATH%;${path.dirname(cliPath)}"`,
    };
  }

  // Linux
  const cliPath = path.join(path.dirname(electronExePath), "resources", "bin", cliShimFilename);
  return {
    title: "Add paseo to your shell",
    detail: "Create a symlink to the bundled Paseo CLI shim.",
    commands: `sudo ln -sf "${cliPath}" /usr/local/bin/paseo`,
  };
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
    cli_symlink_instructions: () => getCliSymlinkInstructions(),
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
      return downloadAndInstallUpdate(currentVersion);
    },
    get_local_daemon_version: () => getLocalDaemonVersion(),
    webview_log: (args) => {
      const level = typeof args?.level === "number" ? args.level : 1;
      const message = typeof args?.message === "string" ? args.message : "";
      const method = level === 0 ? "debug" : level === 2 ? "warn" : level >= 3 ? "error" : "info";
      console[method]("[webview]", message);
    },
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
