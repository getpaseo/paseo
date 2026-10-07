import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAppUpdateService } from "../features/app-update-service";
import { FakeAppUpdateRuntime } from "../features/fake-app-update-runtime";
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

const UPDATE_INFO = {
  version: "1.2.4",
  releaseDate: "2026-04-28T00:00:00.000Z",
  rolloutHours: 24,
};

function createUpdateHandlers(runtime: FakeAppUpdateRuntime) {
  const service = createAppUpdateService({
    runtime,
    isPackaged: () => true,
    now: () => Date.parse("2026-04-28T12:00:00.000Z"),
    bucket: async () => 0,
  });
  return createDaemonCommandHandlers({ installAppUpdate: service.downloadAndInstallUpdate });
}

// Launches a real child process as the daemon supervisor. It writes the lock
// file and idles, so the desktop manager owns a running daemon it can stop.
function installFakeSupervisor(fixtureRoot: string): {
  lockPath: string;
  exit(): void;
  kill(): void;
} {
  mkdirSync(mocks.paseoHome, { recursive: true });
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
  const signal = (name: NodeJS.Signals) => {
    try {
      const lock = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number };
      process.kill(lock.pid, name);
    } catch {
      // The supervisor never started or already exited.
    }
  };
  return { lockPath, exit: () => signal("SIGTERM"), kill: () => signal("SIGKILL") };
}

// Answers `daemon status` from the lock file and keeps `daemon stop` open
// until the test releases it, so a cancel can land mid-stop.
function holdDaemonStop(lockPath: string): {
  requested: Promise<void>;
  release(result: { action: string }): void;
} {
  let release: (result: { action: string }) => void = () => undefined;
  let markRequested: () => void = () => undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
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
      markRequested();
      return await new Promise<{ action: string }>((resolve) => {
        release = resolve;
      });
    }
    throw new Error(`Unexpected CLI command: ${args.join(" ")}`);
  });
  return { requested, release: (result) => release(result) };
}

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

  it("installs when cancel arrives after the daemon accepted the idle stop", async () => {
    const supervisor = installFakeSupervisor(fixtureRoot);
    const stop = holdDaemonStop(supervisor.lockPath);
    const runtime = new FakeAppUpdateRuntime();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: UPDATE_INFO });
    const handlers = createUpdateHandlers(runtime);
    try {
      await handlers.start_desktop_daemon();
      const installing = handlers.install_app_update({ whenIdle: true });
      await stop.requested;

      handlers.cancel_app_update();
      stop.release({ action: "shutdown_requested" });
      supervisor.exit();

      await expect(installing).resolves.toMatchObject({ installed: true });
      expect(runtime.installedVersions).toEqual([UPDATE_INFO.version]);
    } finally {
      supervisor.kill();
      await handlers.stop_desktop_daemon().catch(() => undefined);
    }
  });

  it("ignores a cancel from a window that did not start the update", async () => {
    const runtime = new FakeAppUpdateRuntime();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: UPDATE_INFO });
    const handlers = createUpdateHandlers(runtime);
    const download = runtime.beginUpdateDownload(UPDATE_INFO, { announce: false });

    const installing = handlers.install_app_update({ whenIdle: true }, { senderId: 1 });
    await vi.waitFor(() => expect(runtime.downloadCallCount).toBe(1));

    handlers.cancel_app_update(undefined, { senderId: 2 });
    expect(runtime.cancelCount).toBe(0);

    handlers.cancel_app_update(undefined, { senderId: 1 });
    await expect(installing).resolves.toMatchObject({ installed: false, cancelled: true });
    expect(runtime.cancelCount).toBe(1);
    expect(runtime.installedVersions).toEqual([]);
    download.resolve();
  });
});
