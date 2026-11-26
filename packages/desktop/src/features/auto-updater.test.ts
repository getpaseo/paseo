import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UUID } from "builder-util-runtime";
import { describe, expect, it, vi } from "vitest";

const { autoUpdaterMock, getAllWindowsMock, desktopSettingsMock } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  return {
    getAllWindowsMock: vi.fn<() => unknown[]>(() => []),
    desktopSettingsMock: {
      mode: "automatic" as "automatic" | "notify" | "off",
      error: null as Error | null,
    },
    autoUpdaterMock: {
      handlers: {
        get: (event: string) => (value: unknown) => {
          for (const listener of handlers.get(event) ?? []) {
            listener(value);
          }
        },
      },
      logger: {
        debug: vi.fn(),
        error: vi.fn((message: unknown) => console.error(message)),
        info: vi.fn(),
        warn: vi.fn(),
      },
      checkForUpdates: vi.fn(),
      downloadUpdate: vi.fn(),
      on: vi.fn((event: string, handler: (value: unknown) => void) => {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler);
      }),
      removeListener: vi.fn((event: string, handler: (value: unknown) => void) => {
        handlers.get(event)?.delete(handler);
      }),
      quitAndInstall: vi.fn(),
    },
  };
});

vi.mock("electron", () => ({
  app: {
    // No userData path: update pacing has no state file here, so it paces nothing.
    getPath: vi.fn(),
    isPackaged: true,
  },
  autoUpdater: undefined,
  BrowserWindow: {
    getAllWindows: getAllWindowsMock,
  },
}));

vi.mock("../settings/desktop-settings-electron.js", () => ({
  getDesktopSettingsStore: () => ({
    get: async () => {
      if (desktopSettingsMock.error) {
        throw desktopSettingsMock.error;
      }
      return {
        releaseChannel: "stable",
        updates: { mode: desktopSettingsMock.mode },
        notifications: { playSound: true },
        daemon: { manageBuiltInDaemon: true, keepRunningAfterQuit: true },
      };
    },
  }),
}));

vi.mock("electron-updater", () => ({
  autoUpdater: autoUpdaterMock,
}));

import {
  checkForAppUpdate,
  createAppUpdateLifecycleLogger,
  downloadAndInstallUpdate,
  resolveStagingUserId,
  runElectronQuitAndInstall,
  shouldInstallAppUpdateOnQuit,
  shouldUseWindowProgressBar,
} from "./auto-updater";

describe("checkForAppUpdate", () => {
  it("treats an unpublished channel manifest as an unavailable update", async () => {
    const error = Object.assign(new Error("Cannot find latest-mac.yml"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterMock.logger.error(error);
      autoUpdaterMock.handlers.get("error")?.(error);
      throw error;
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("keeps genuine updater failures visible", async () => {
    const error = new Error("network down");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockImplementationOnce(async () => {
      autoUpdaterMock.logger.error(error);
      autoUpdaterMock.handlers.get("error")?.(error);
      throw error;
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result.errorMessage).toBe("network down");
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("configures electron-updater autoDownload from checkForAppUpdate options", async () => {
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: "1.2.5" },
    });

    const result = await checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: false,
    });

    expect((autoUpdaterMock as unknown as { autoDownload?: boolean }).autoDownload).toBe(false);
    expect(result).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
      latestVersion: "1.2.5",
    });
  });

  it("forwards download-progress to window progress bars on non-darwin platforms and avoids idle clears", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const setProgressBar = vi.fn();
    const send = vi.fn();
    try {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, setProgressBar, webContents: { send } },
      ]);
      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: { version: "1.2.6" },
      });

      await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "automatic",
        autoDownload: true,
      });
      expect(setProgressBar).not.toHaveBeenCalled();

      autoUpdaterMock.handlers.get("download-progress")?.({
        percent: 42,
        transferred: 420,
        total: 1000,
        bytesPerSecond: 100,
      });

      expect(setProgressBar).toHaveBeenCalledWith(0.42);
      expect(send).toHaveBeenCalledWith("paseo:event:app-update-download-progress", {
        version: "1.2.6",
        percent: 42,
        transferred: 420,
        total: 1000,
        bytesPerSecond: 100,
      });

      autoUpdaterMock.handlers.get("update-downloaded")?.({ version: "1.2.6" });
      expect(setProgressBar).toHaveBeenLastCalledWith(-1);
      expect(setProgressBar).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenLastCalledWith("paseo:event:app-update-download-progress", null);

      // A subsequent idle clear (e.g., switching channels) must not call setProgressBar(-1) again.
      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: false,
        updateInfo: { version: "1.2.3" },
      });
      await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "beta",
        intent: "manual",
      });
      expect(setProgressBar).toHaveBeenCalledTimes(2);
    } finally {
      getAllWindowsMock.mockReturnValue([]);
      platformSpy.mockRestore();
    }
  });

  it("skips window progress bars on darwin while still forwarding renderer events", async () => {
    expect(shouldUseWindowProgressBar("darwin")).toBe(false);
    expect(shouldUseWindowProgressBar("win32")).toBe(true);
    expect(shouldUseWindowProgressBar("linux")).toBe(true);

    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const setProgressBar = vi.fn();
    const send = vi.fn();
    try {
      getAllWindowsMock.mockReturnValue([
        { isDestroyed: () => false, setProgressBar, webContents: { send } },
      ]);
      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: { version: "1.2.11" },
      });

      await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "automatic",
        autoDownload: true,
      });
      autoUpdaterMock.handlers.get("download-progress")?.({
        percent: 55,
        transferred: 550,
        total: 1000,
        bytesPerSecond: 100,
      });
      autoUpdaterMock.handlers.get("update-downloaded")?.({ version: "1.2.11" });

      expect(setProgressBar).not.toHaveBeenCalled();
      expect(send).toHaveBeenCalledWith("paseo:event:app-update-download-progress", {
        version: "1.2.11",
        percent: 55,
        transferred: 550,
        total: 1000,
        bytesPerSecond: 100,
      });
      expect(send).toHaveBeenLastCalledWith("paseo:event:app-update-download-progress", null);
    } finally {
      getAllWindowsMock.mockReturnValue([]);
      platformSpy.mockRestore();
    }
  });

  it("gates automatic checks and autoDownload from desktop settings and falls back to automatic on read failure", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      autoUpdaterMock.checkForUpdates.mockClear();
      desktopSettingsMock.mode = "off";
      const offAuto = await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "automatic",
      });
      expect(offAuto.hasUpdate).toBe(false);
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled();

      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: { version: "1.2.9" },
      });
      const offManual = await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "manual",
      });
      expect(offManual).toMatchObject({
        hasUpdate: true,
        downloading: false,
        latestVersion: "1.2.9",
      });

      desktopSettingsMock.mode = "automatic";
      desktopSettingsMock.error = new SyntaxError("Unexpected token } in JSON");
      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: { version: "1.2.10" },
      });
      const fallbackResult = await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "automatic",
      });
      expect(fallbackResult).toMatchObject({
        hasUpdate: true,
        downloading: true,
        latestVersion: "1.2.10",
      });
      expect(consoleWarn).toHaveBeenCalled();
      autoUpdaterMock.handlers.get("update-downloaded")?.({ version: "1.2.10" });
    } finally {
      desktopSettingsMock.mode = "automatic";
      desktopSettingsMock.error = null;
      consoleWarn.mockRestore();
    }
  });

  it("does not fail update events when setProgressBar throws", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const send = vi.fn();
    try {
      getAllWindowsMock.mockReturnValue([
        {
          isDestroyed: () => false,
          setProgressBar: () => {
            throw new Error("unsupported desktop environment");
          },
          webContents: { send },
        },
      ]);
      autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
        isUpdateAvailable: true,
        updateInfo: { version: "1.2.7" },
      });

      await checkForAppUpdate({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        intent: "automatic",
        autoDownload: true,
      });
      expect(() => {
        autoUpdaterMock.handlers.get("download-progress")?.({
          percent: 50,
          transferred: 50,
          total: 100,
          bytesPerSecond: 10,
        });
      }).not.toThrow();
      expect(send).toHaveBeenCalledWith(
        "paseo:event:app-update-download-progress",
        expect.objectContaining({ version: "1.2.7", percent: 50 }),
      );
    } finally {
      getAllWindowsMock.mockReturnValue([]);
      platformSpy.mockRestore();
    }
  });

  it("reports a failure when quitAndInstall emits an installer error and returns normally", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    autoUpdaterMock.checkForUpdates.mockResolvedValueOnce({
      isUpdateAvailable: true,
      updateInfo: { version: "1.2.8" },
    });
    autoUpdaterMock.downloadUpdate.mockResolvedValueOnce(undefined);
    autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
      autoUpdaterMock.handlers.get("error")?.(new Error("EROFS: read-only file system"));
    });

    const result = await downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });

    expect(result).toMatchObject({
      installed: false,
      errorMessage: "EROFS: read-only file system",
    });
    consoleError.mockRestore();
  });

  it("waits on macOS explicit installs until Squirrel reports an error or signals quit, while returning immediately on quit-time handoff", async () => {
    const updater = Object.assign(new EventEmitter(), {
      quitAndInstall: vi.fn(),
    });
    const nativeUpdater = new EventEmitter();

    const failedInstall = runElectronQuitAndInstall({
      platform: "darwin",
      updater,
      nativeUpdater,
      isSilent: false,
      isForceRunAfter: true,
    });
    expect(
      await Promise.race([failedInstall.then(() => "settled"), Promise.resolve("pending")]),
    ).toBe("pending");

    nativeUpdater.emit("error", new Error("Code signature invalid"));
    await expect(failedInstall).resolves.toEqual({
      started: false,
      errorMessage: "Code signature invalid",
    });
    expect(updater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);

    const restartInstall = runElectronQuitAndInstall({
      platform: "darwin",
      updater,
      nativeUpdater,
      isSilent: false,
      isForceRunAfter: true,
    });
    nativeUpdater.emit("before-quit-for-update");
    await expect(restartInstall).resolves.toEqual({ started: true });

    // Quit-time install (isForceRunAfter: false) returns immediately so
    // quit-lifecycle owns its separate handoff deadline.
    await expect(
      runElectronQuitAndInstall({
        platform: "darwin",
        updater,
        nativeUpdater,
        isSilent: true,
        isForceRunAfter: false,
      }),
    ).resolves.toEqual({ started: true });
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);

    // Explicit install times out cleanly instead of hanging forever if Squirrel never emits.
    await expect(
      runElectronQuitAndInstall({
        platform: "darwin",
        updater,
        nativeUpdater,
        isSilent: false,
        isForceRunAfter: true,
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      started: false,
      errorMessage: "Timed out waiting for the update installer to start.",
    });
    expect(updater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("error")).toBe(0);
    expect(nativeUpdater.listenerCount("before-quit-for-update")).toBe(0);
  });

  it("logs the update handoff with current and selected target versions", () => {
    const info = vi.fn();
    const lifecycleLog = createAppUpdateLifecycleLogger({ info });

    lifecycleLog.checkStarted({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    lifecycleLog.checkCompleted({
      currentVersion: "1.2.3",
      targetVersion: "1.2.5",
      releaseChannel: "stable",
      intent: "manual",
      hasUpdate: true,
      readyToInstall: true,
      errorMessage: null,
    });
    lifecycleLog.updateDownloaded("1.2.4");
    lifecycleLog.downloadRequested("1.2.5");
    lifecycleLog.quitAndInstallRequested({
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });

    expect(info).toHaveBeenCalledWith("[auto-updater] check started", {
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] update downloaded", {
      targetVersion: "1.2.4",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] download requested", {
      targetVersion: "1.2.5",
    });
    expect(info).toHaveBeenCalledWith("[auto-updater] quitAndInstall requested", {
      targetVersion: "1.2.5",
      isSilent: false,
      isForceRunAfter: true,
    });
  });
});

describe("shouldInstallAppUpdateOnQuit", () => {
  it("keeps Linux AppImage updates on the manual install path", () => {
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: true })).toBe(false);
    expect(shouldInstallAppUpdateOnQuit({ platform: "linux", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "darwin", isAppImage: false })).toBe(true);
    expect(shouldInstallAppUpdateOnQuit({ platform: "win32", isAppImage: false })).toBe(true);
  });
});

describe("resolveStagingUserId", () => {
  it("creates and then reuses the on-disk staging user id", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-updater-id-"));
    const filePath = path.join(tempDir, ".updaterId");

    try {
      const first = await resolveStagingUserId(filePath);
      const stored = (await readFile(filePath, "utf8")).trim();
      const second = await resolveStagingUserId(filePath);

      expect(UUID.check(stored)).toBeTruthy();
      expect(second).toBe(first);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });
});
