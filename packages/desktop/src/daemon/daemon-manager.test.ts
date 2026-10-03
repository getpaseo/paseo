import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_DESKTOP_SETTINGS } from "../settings/desktop-settings";
import { createDaemonCommandHandlers } from "./daemon-manager";

const mocks = vi.hoisted(() => ({
  paseoHome: "",
  settings: {
    releaseChannel: "stable",
    daemon: {
      manageBuiltInDaemon: true,
      keepRunningAfterQuit: true,
    },
  },
  runExternalCliJsonCommand: vi.fn(),
  runExternalCliTextCommand: vi.fn(),
  createNodeEntrypointInvocation: vi.fn(() => ({
    command: "node",
    args: [],
    env: {},
  })),
  spawnProcess: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  appLogPath: "",
  getElectronLogFile: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => mocks.paseoHome),
    getVersion: vi.fn(() => "1.2.3"),
    isPackaged: true,
  },
  ipcMain: { handle: vi.fn() },
  powerMonitor: { getSystemIdleTime: vi.fn(() => 0) },
}));

vi.mock("electron-log/main", () => ({
  default: {
    info: mocks.logInfo,
    error: mocks.logError,
    transports: {
      file: {
        getFile: mocks.getElectronLogFile,
      },
    },
  },
}));

vi.mock("@getpaseo/server/daemon-control", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePaseoHome: () => mocks.paseoHome,
  spawnProcess: mocks.spawnProcess,
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => mocks.settings,
    patch: vi.fn(),
    migrateLegacyRendererSettings: vi.fn(),
  }),
}));

vi.mock("./runtime-paths.js", () => ({
  createNodeEntrypointInvocation: mocks.createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint: vi.fn(() => ({
    entryPath: path.join(mocks.paseoHome, "daemon.js"),
    execArgv: [],
  })),
}));

vi.mock("./cli/external.js", () => ({
  runExternalCliJsonCommand: mocks.runExternalCliJsonCommand,
  runExternalCliTextCommand: mocks.runExternalCliTextCommand,
}));

vi.mock("../features/auto-updater.js", () => ({
  checkForAppUpdate: vi.fn(),
  downloadAndInstallUpdate: vi.fn(
    async (_input: unknown, onBeforeQuit?: () => Promise<boolean>) => {
      const proceed = onBeforeQuit ? await onBeforeQuit() : true;
      return {
        installed: proceed,
        ...(proceed ? {} : { cancelled: true }),
        version: "1.2.4",
        message: proceed
          ? "Update downloaded. The app will restart shortly."
          : "Installation cancelled.",
      };
    },
  ),
}));

describe("daemon-manager commands", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), "paseo daemon manager "));
    mocks.paseoHome = path.join(fixtureRoot, "home");
    mocks.appLogPath = path.join(fixtureRoot, "main.log");
    mocks.settings = DEFAULT_DESKTOP_SETTINGS;
    mocks.runExternalCliJsonCommand.mockReset();
    mocks.runExternalCliTextCommand.mockReset();
    mocks.createNodeEntrypointInvocation.mockReset();
    mocks.createNodeEntrypointInvocation.mockReturnValue({ command: "node", args: [], env: {} });
    mocks.spawnProcess.mockReset();
    mocks.logInfo.mockReset();
    mocks.logError.mockReset();
    mocks.getElectronLogFile.mockReset();
    mocks.getElectronLogFile.mockReturnValue({ path: mocks.appLogPath });
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns the Electron main-process log tail from electron-log", () => {
    writeFileSync(
      mocks.appLogPath,
      Array.from({ length: 105 }, (_value, index) => `main log line ${index + 1}`).join("\n"),
    );
    const handlers = createDaemonCommandHandlers();

    expect(handlers.desktop_app_logs()).toEqual({
      logPath: mocks.appLogPath,
      contents: Array.from({ length: 100 }, (_value, index) => `main log line ${index + 6}`).join(
        "\n",
      ),
    });
  });

  it("exposes updater diagnostics through the desktop command boundary", () => {
    const diagnostics = createDaemonCommandHandlers().desktop_update_diagnostics();

    expect(diagnostics).toMatchObject({
      platform: process.platform,
      currentVersion: "1.2.3",
    });
  });

  it("reports a stopped daemon without launching the CLI when no local daemon runs", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "server-id"), "srv_existing\n");
    mocks.runExternalCliJsonCommand.mockResolvedValue({
      home: mocks.paseoHome,
      pid: null,
      startedAt: null,
      listen: null,
      hostname: null,
      localDaemon: "stopped",
      desktopManaged: false,
      connectedDaemon: "not_probed",
    });

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "stopped", pid: null });
    expect(mocks.runExternalCliJsonCommand).not.toHaveBeenCalled();
  });

  it("reports an errored daemon when the local daemon state cannot be read", async () => {
    mkdirSync(mocks.paseoHome);
    writeFileSync(path.join(mocks.paseoHome, "paseo.pid"), "garbage");

    const status = await createDaemonCommandHandlers().desktop_daemon_status();

    expect(status).toMatchObject({ serverId: "", status: "errored", pid: null });
    expect(status.error).toBeTruthy();
  });

  it("returns a local credential only for its live managed daemon listen", async () => {
    mkdirSync(mocks.paseoHome);
    const token = "a".repeat(43);
    writeFileSync(path.join(mocks.paseoHome, "local-credential"), `${token}\n`, { mode: 0o600 });
    const lock = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      hostname: hostname(),
      uid: process.getuid?.() ?? 0,
      listen: "127.0.0.1:6799",
      desktopManaged: true,
    };
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    writeFileSync(lockPath, JSON.stringify(lock));
    const handler = createDaemonCommandHandlers().desktop_local_credential;
    expect(await handler({ listen: "localhost:6799" })).toBe(token);
    expect(await handler({ listen: "remote:6799" })).toBeNull();
    writeFileSync(lockPath, JSON.stringify({ ...lock, desktopManaged: false }));
    expect(await handler({ listen: "localhost:6799" })).toBeNull();
  });

  it("does not install when cancel arrives while the idle stop is finishing", async () => {
    mkdirSync(mocks.paseoHome);
    const lockPath = path.join(mocks.paseoHome, "paseo.pid");
    const supervisorPath = path.join(fixtureRoot, "supervisor.mjs");
    writeFileSync(
      supervisorPath,
      [
        "import { writeFileSync } from 'node:fs';",
        "import { hostname } from 'node:os';",
        "writeFileSync(process.argv[2], JSON.stringify({",
        "  pid: process.pid,",
        "  startedAt: new Date().toISOString(),",
        "  hostname: hostname(),",
        "  uid: process.getuid?.() ?? 0,",
        "  listen: '127.0.0.1:6799',",
        "  desktopManaged: true,",
        "}));",
        "setInterval(() => {}, 60_000);",
      ].join("\n"),
    );
    mocks.createNodeEntrypointInvocation.mockReturnValue({
      command: process.execPath,
      args: [supervisorPath, lockPath],
      env: {},
    });
    let releaseStop: (result: { action: string }) => void = () => undefined;
    let markStopCalled: () => void = () => undefined;
    const stopCalled = new Promise<void>((resolve) => {
      markStopCalled = resolve;
    });
    mocks.runExternalCliJsonCommand.mockImplementation(async (args: string[]) => {
      if (args[1] === "status") {
        const lock = JSON.parse(readFileSync(lockPath, "utf8")) as {
          pid: number;
          startedAt: string;
        };
        return {
          localDaemon: "running",
          pid: lock.pid,
          startedAt: lock.startedAt,
          listen: "127.0.0.1:6799",
          hostname: hostname(),
          daemonVersion: "1.2.3",
          desktopManaged: true,
          serverId: "srv_test",
        };
      }
      if (args[1] === "stop") {
        markStopCalled();
        return await new Promise<{ action: string }>((resolve) => {
          releaseStop = resolve;
        });
      }
      throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
    });

    const handlers = createDaemonCommandHandlers();
    let supervisorPid: number | null = null;
    try {
      await handlers.start_desktop_daemon();
      const installing = handlers.install_app_update({ whenIdle: true });
      await stopCalled;
      supervisorPid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid;
      handlers.cancel_app_update();
      releaseStop({ action: "shutdown_requested" });
      try {
        process.kill(supervisorPid, "SIGTERM");
      } catch {
        // The supervisor can already be gone.
      }
      await expect(installing).resolves.toMatchObject({ installed: false, cancelled: true });
    } finally {
      if (supervisorPid !== null) {
        try {
          process.kill(supervisorPid, "SIGKILL");
        } catch {
          // The supervisor already exited.
        }
      }
      await handlers.stop_desktop_daemon().catch(() => undefined);
    }
  });
});
