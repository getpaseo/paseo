import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopUpdateMode } from "../settings/desktop-settings";

import {
  AUTOMATIC_CHECK_INTERVAL_MS,
  UPDATE_COOLDOWN_MS,
  createAppUpdatePacing,
  type AppUpdatePacing,
} from "./app-update-pacing";
import type { AppReleaseChannel, AppUpdateCheckIntent } from "./app-update-rollout";
import {
  createAppUpdateService,
  type AppUpdateCheckResult,
  type AppUpdateDownloadProgress,
  type AppUpdateInstallRequest,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type RuntimeDownloadProgressInfo,
  type RuntimeUpdateCheckResult,
  type RuntimeUpdateInfo,
} from "./app-update-service";

class FakeAppUpdateRuntime implements AppUpdateRuntime {
  private checks: Array<
    | { isUpdateAvailable: boolean; updateInfo: RuntimeUpdateInfo }
    | null
    | Error
    | { kind: "check-error"; error: Error; emitRuntimeError: boolean }
    | { kind: "deferred"; promise: Promise<RuntimeUpdateCheckResult | null> }
  > = [];
  private gate: ((info: RuntimeUpdateInfo) => boolean | Promise<boolean>) | null = null;
  private configuration: AppUpdateRuntimeConfiguration | null = null;
  private downloadableUpdate: RuntimeUpdateInfo | null = null;
  private downloadedUpdate: RuntimeUpdateInfo | null = null;
  private activeDownload: {
    info: RuntimeUpdateInfo;
    promise: Promise<void>;
    resolve(): void;
    reject(error: Error): void;
  } | null = null;
  lastAutoDownload: boolean | null = null;
  nextQuitAndInstallResult: { started: boolean; errorMessage?: string } | null = null;
  checkCount = 0;
  downloadCallCount = 0;
  requestedDownloadVersions: string[] = [];
  downloadedVersions: string[] = [];
  installedVersions: string[] = [];
  installModes: Array<{ targetVersion: string; isSilent: boolean; isForceRunAfter: boolean }> = [];

  configure(input: AppUpdateRuntimeConfiguration): void {
    this.configuration = input;
    this.lastAutoDownload = input.autoDownload;
    this.gate = input.shouldAdmitUpdate;
  }

  setAutoDownload(enabled: boolean): void {
    this.lastAutoDownload = enabled;
  }

  emitDownloadProgress(progress: RuntimeDownloadProgressInfo): void {
    this.configuration?.onDownloadProgress(progress);
  }

  nextCheck(result: { isUpdateAvailable: boolean; updateInfo: RuntimeUpdateInfo } | null): void {
    this.checks.push(result);
  }

  failNextCheck(error: Error): void {
    this.checks.push(error);
  }

  failNextCheckAndEmitRuntimeError(error: Error): void {
    this.checks.push({ kind: "check-error", error, emitRuntimeError: true });
  }

  deferNextCheck(): {
    resolve(result: RuntimeUpdateCheckResult | null): void;
    reject(error: Error): void;
  } {
    let resolve!: (result: RuntimeUpdateCheckResult | null) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<RuntimeUpdateCheckResult | null>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.checks.push({ kind: "deferred", promise });
    return { resolve, reject };
  }

  failRuntime(error: Error): void {
    this.configuration?.onError(error);
  }

  prepareUpdate(info: RuntimeUpdateInfo): void {
    this.configuration?.onUpdateAvailable(info);
  }

  finishUpdateDownload(info: RuntimeUpdateInfo): void {
    this.downloadedUpdate = info;
    this.downloadedVersions.push(info.version);
    this.configuration?.onUpdateDownloaded(info);
  }

  beginUpdateDownload(info: RuntimeUpdateInfo): {
    resolve(): void;
    reject(error: Error): void;
  } {
    this.downloadableUpdate = info;
    this.prepareUpdate(info);
    let resolvePromise!: () => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    void promise.catch(() => undefined);
    const activeDownload = {
      info,
      promise,
      resolve: () => {
        this.finishUpdateDownload(info);
        this.activeDownload = null;
        resolvePromise();
      },
      reject: (error: Error) => {
        this.configuration?.onError(error);
        this.activeDownload = null;
        rejectPromise(error);
      },
    };
    this.activeDownload = activeDownload;
    return { resolve: activeDownload.resolve, reject: activeDownload.reject };
  }

  async checkForUpdates(): Promise<{
    isUpdateAvailable: boolean;
    updateInfo: RuntimeUpdateInfo;
  } | null> {
    this.checkCount += 1;
    const result = this.checks.shift() ?? null;
    if (result instanceof Error) throw result;
    if (result?.kind === "check-error") {
      if (result.emitRuntimeError) {
        this.configuration?.onError(result.error);
      }
      throw result.error;
    }
    if (result?.kind === "deferred") {
      return result.promise;
    }
    if (!result || !this.gate) return result;
    const admitted = await this.gate(result.updateInfo);
    const isUpdateAvailable = result.isUpdateAvailable && admitted;
    this.downloadableUpdate = isUpdateAvailable ? result.updateInfo : null;
    return { ...result, isUpdateAvailable };
  }

  async downloadUpdate(targetVersion: string): Promise<void> {
    this.downloadCallCount += 1;
    this.requestedDownloadVersions.push(targetVersion);
    if (this.activeDownload) {
      return this.activeDownload.promise;
    }
    if (this.downloadableUpdate) {
      this.finishUpdateDownload(this.downloadableUpdate);
    }
  }

  quitAndInstall({ targetVersion, isSilent, isForceRunAfter }: AppUpdateInstallRequest) {
    if (this.nextQuitAndInstallResult) {
      const outcome = this.nextQuitAndInstallResult;
      this.nextQuitAndInstallResult = null;
      return outcome;
    }
    if (this.downloadedUpdate) {
      this.installedVersions.push(this.downloadedUpdate.version);
      this.installModes.push({ targetVersion, isSilent, isForceRunAfter });
    }
    return { started: true };
  }
}

/** An install whose automatic checks are always due and that never updated recently. */
const unpaced: AppUpdatePacing = {
  start: async () => undefined,
  isAutomaticCheckDue: async () => true,
  recordAutomaticCheck: async () => undefined,
  isInUpdateCooldown: async () => false,
};

function createService(input?: {
  now?: () => number;
  bucket?: (version: string) => Promise<number>;
  pacing?: AppUpdatePacing;
  updateMode?: () => DesktopUpdateMode | Promise<DesktopUpdateMode>;
  reportSettingsError?: (error: unknown) => void;
  onDownloadProgress?: (progress: AppUpdateDownloadProgress | null) => void;
}) {
  const runtime = new FakeAppUpdateRuntime();
  const service = createAppUpdateService({
    runtime,
    isPackaged: () => true,
    now: input?.now ?? (() => Date.parse("2026-04-28T12:00:00.000Z")),
    bucket: input?.bucket ?? (async () => 0.99),
    pacing: input?.pacing ?? unpaced,
    updateMode: input?.updateMode,
    reportSettingsError: input?.reportSettingsError,
    onDownloadProgress: input?.onDownloadProgress,
  });
  return { runtime, service };
}

const rolledOutUpdate = {
  version: "1.2.4",
  releaseDate: "2026-04-28T00:00:00.000Z",
  rolloutHours: 24,
};

describe("app update service", () => {
  it("does not expose automatic stable updates before the user is admitted to rollout", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
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
  });

  it("exposes manual stable updates even before the user is admitted to rollout", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("keeps a manually admitted update after a rollout-gated automatic recheck", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(result).toMatchObject({
      hasUpdate: true,
      readyToInstall: true,
      latestVersion: "1.2.4",
    });
  });

  it("keeps preparing a manually admitted update after a rollout-gated automatic recheck", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(result).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      latestVersion: "1.2.4",
    });
  });

  it("clears a cached update when the manifest no longer contains it", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.nextCheck(null);
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(result.hasUpdate).toBe(false);
  });

  it("waits for an automatic poll before starting a manual rollout-bypassing check", async () => {
    const { runtime, service } = createService();
    const automaticCheck = runtime.deferNextCheck();
    const automaticPending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const manualPending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.checkCount).toBe(1);

    automaticCheck.resolve({ isUpdateAvailable: false, updateInfo: rolledOutUpdate });
    await automaticPending;
    const manualResult = await manualPending;

    expect(runtime.checkCount).toBe(2);
    expect(manualResult.hasUpdate).toBe(true);
    expect(manualResult.latestVersion).toBe("1.2.4");
  });

  it("performs a fresh manual check when an update is already cached", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    runtime.nextCheck({
      isUpdateAvailable: true,
      updateInfo: { ...rolledOutUpdate, version: "1.2.5" },
    });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.5",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("replaces a downloaded update when a later release that skips a version is admitted", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    const laterUpdate = { ...rolledOutUpdate, version: "1.2.6" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: laterUpdate });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.6",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("installs the newest admitted release when quitting with an older download", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    const laterUpdate = { ...rolledOutUpdate, version: "1.2.6" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: laterUpdate });
    const installed = await service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(installed).toBe(true);
    expect(runtime.installedVersions).toEqual(["1.2.6"]);
    expect(runtime.installModes).toEqual([
      { targetVersion: "1.2.6", isSilent: true, isForceRunAfter: false },
    ]);
  });

  it("does not install an older download when a later release that skips a version is still rolling out", async () => {
    const now = Date.parse("2026-04-28T12:00:00.000Z");
    const { runtime, service } = createService({ now: () => now, bucket: async () => 0.4 });
    const olderUpdate = {
      ...rolledOutUpdate,
      releaseDate: "2026-04-27T00:00:00.000Z",
    };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: olderUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(olderUpdate);

    const laterUpdate = {
      ...rolledOutUpdate,
      version: "1.2.6",
      releaseDate: "2026-04-28T12:00:00.000Z",
    };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: laterUpdate });
    const installed = await service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(installed).toBe(false);
    expect(runtime.installedVersions).toEqual([]);
  });

  it("does not install after quit-time revalidation expires", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    const deadline = new AbortController();
    deadline.abort();
    runtime.nextCheck({
      isUpdateAvailable: true,
      updateInfo: { ...rolledOutUpdate, version: "1.2.5" },
    });
    const installed = await service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: deadline.signal,
    });

    expect(installed).toBe(false);
    expect(runtime.installedVersions).toEqual([]);
  });

  it("does not install an unvalidated download when the quit-time check fails", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.failNextCheck(new Error("offline"));
    const installed = await service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(installed).toBe(false);
    expect(runtime.installedVersions).toEqual([]);
  });

  it("rechecks for the newest release before a manual install", async () => {
    const { runtime, service } = createService({ bucket: async () => 0.99 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const result = await service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });

    expect(result.installed).toBe(true);
    expect(runtime.installedVersions).toEqual(["1.2.5"]);
    expect(runtime.installModes).toEqual([
      { targetVersion: "1.2.5", isSilent: false, isForceRunAfter: true },
    ]);
  });

  it("waits for a stale active download before downloading and installing the rechecked version", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    const staleDownload = runtime.beginUpdateDownload(rolledOutUpdate);

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const installPending = service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    await Promise.resolve();
    expect(runtime.installedVersions).toEqual([]);

    staleDownload.resolve();
    const result = await installPending;

    expect(result.installed).toBe(true);
    expect(runtime.downloadedVersions).toEqual(["1.2.4", "1.2.5"]);
    expect(runtime.requestedDownloadVersions).toEqual(["1.2.5"]);
    expect(runtime.installedVersions).toEqual(["1.2.5"]);
  });

  it("installs the rechecked version when the stale active download fails", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    const staleDownload = runtime.beginUpdateDownload(rolledOutUpdate);

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const installPending = service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.downloadCallCount).toBe(1);

    staleDownload.reject(new Error("old download failed"));
    const result = await installPending;

    expect(result.installed).toBe(true);
    expect(runtime.downloadedVersions).toEqual(["1.2.5"]);
    expect(runtime.installedVersions).toEqual(["1.2.5"]);
  });

  it("trusts the runtime availability decision before comparing versions", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: false, updateInfo: rolledOutUpdate });

    const result = await service.checkForAppUpdate({
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
  });

  it("returns check errors so the renderer can show feedback", async () => {
    const { runtime, service } = createService();
    runtime.failNextCheck(new Error("network down"));

    const result = await service.checkForAppUpdate({
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
      errorMessage: "network down",
    });
  });

  it("performs a fresh retry after a failed check emits a runtime error", async () => {
    const { runtime, service } = createService();
    runtime.failNextCheckAndEmitRuntimeError(new Error("network down"));

    const firstResult = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(firstResult.errorMessage).toBe("network down");

    runtime.nextCheck(null);
    const retryResult = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(runtime.checkCount).toBe(2);
    expect(retryResult).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
  });

  it("does not replay runtime errors emitted by the active check to automatic consumers", async () => {
    const { runtime, service } = createService();
    runtime.failNextCheckAndEmitRuntimeError(new Error("network down"));

    const checkResult = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    expect(checkResult.errorMessage).toBe("network down");

    const automaticResult = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(runtime.checkCount).toBe(2);
    expect(automaticResult).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
  });

  it("does not cache runtime errors from overlapping active checks", async () => {
    const { runtime, service } = createService();
    const firstCheck = runtime.deferNextCheck();
    const firstPending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    const secondCheck = runtime.deferNextCheck();
    const secondPending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    firstCheck.resolve(null);
    await firstPending;

    runtime.failRuntime(new Error("network down"));
    secondCheck.reject(new Error("network down"));
    const secondResult = await secondPending;
    expect(secondResult.errorMessage).toBe("network down");

    runtime.nextCheck(null);
    const automaticResult = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(runtime.checkCount).toBe(3);
    expect(automaticResult).toEqual({
      hasUpdate: false,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      body: null,
      date: null,
      errorMessage: null,
    });
  });

  it("surfaces preparation errors without blocking newer releases", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.prepareUpdate(rolledOutUpdate);
    runtime.failRuntime(new Error("sha512 checksum mismatch"));

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const failedPreparation = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(failedPreparation).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: "sha512 checksum mismatch",
    });

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.5",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("attributes a late preparation failure to the download that started it", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.prepareUpdate(rolledOutUpdate);

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.failRuntime(new Error("old download failed"));

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    expect(result.latestVersion).toBe("1.2.5");
    expect(result.errorMessage).toBeNull();
  });

  it("performs a fresh manual check after an update preparation error", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.prepareUpdate(rolledOutUpdate);
    runtime.failRuntime(new Error("sha512 checksum mismatch"));

    runtime.nextCheck({
      isUpdateAvailable: true,
      updateInfo: { ...rolledOutUpdate, version: "1.2.5" },
    });
    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.5",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("keeps a downloaded update ready when a manual check re-announces it", async () => {
    const { runtime, service } = createService();
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    const recheck = runtime.deferNextCheck();
    const pending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
    });
    runtime.prepareUpdate(rolledOutUpdate);
    recheck.resolve({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const result = await pending;

    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: true,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("reports an available update without downloading when autoDownload is false", async () => {
    const progressEvents: Array<AppUpdateDownloadProgress | null> = [];
    const { runtime, service } = createService({
      bucket: async () => 0,
      onDownloadProgress: (progress) => progressEvents.push(progress),
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    const result = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: false,
    });

    expect(runtime.lastAutoDownload).toBe(false);
    expect(result).toEqual({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const activeDownload = runtime.beginUpdateDownload(rolledOutUpdate);
    const installPending = service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    await Promise.resolve();
    runtime.emitDownloadProgress({
      percent: 45,
      transferred: 45,
      total: 100,
      bytesPerSecond: 10,
    });
    activeDownload.resolve();
    const installResult = await installPending;

    expect(installResult.installed).toBe(true);
    expect(progressEvents).toContainEqual({
      version: "1.2.4",
      percent: 45,
      transferred: 45,
      total: 100,
      bytesPerSecond: 10,
    });
    expect(progressEvents[progressEvents.length - 1]).toBeNull();
  });

  it("allows retrying the same version after a transient download failure in notify/off mode", async () => {
    const progressEvents: Array<AppUpdateDownloadProgress | null> = [];
    const { runtime, service } = createService({
      bucket: async () => 0,
      onDownloadProgress: (progress) => progressEvents.push(progress),
    });

    // 1. Discover v1.2.4 without auto-downloading.
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const discovered = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
      autoDownload: false,
    });
    expect(discovered).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
      latestVersion: "1.2.4",
    });

    // 2. First explicit download fails transiently mid-transfer.
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const failingDownload = runtime.beginUpdateDownload(rolledOutUpdate);
    const failedInstallPromise = service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.downloadCallCount).toBe(1);
    runtime.emitDownloadProgress({
      percent: 37,
      transferred: 37,
      total: 100,
      bytesPerSecond: 10,
    });
    failingDownload.reject(new Error("ECONNRESET"));
    const failedInstall = await failedInstallPromise;

    expect(failedInstall).toMatchObject({
      installed: false,
      errorMessage: "ECONNRESET",
    });
    expect(progressEvents[progressEvents.length - 1]).toBeNull();

    // 3. User retries manual Check for the SAME version (v1.2.4) — must not be stranded on stale error!
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const retryCheck = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "manual",
      autoDownload: false,
    });
    expect(retryCheck).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
      latestVersion: "1.2.4",
      errorMessage: null,
    });

    // 4. Second explicit download succeeds and installs cleanly.
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const retryInstall = await service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    expect(retryInstall.installed).toBe(true);
    expect(runtime.installedVersions).toEqual(["1.2.4"]);
  });

  it("downloads and installs a newer release if one ships after notify discovery", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: false,
    });

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const result = await service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });

    expect(result.installed).toBe(true);
    expect(runtime.installedVersions).toEqual(["1.2.5"]);
  });

  it("reuses an already-downloaded update when installing manually after switching to notify/off", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: true,
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const result = await service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });

    expect(result.installed).toBe(true);
    expect(runtime.downloadCallCount).toBe(0);
    expect(runtime.installedVersions).toEqual(["1.2.4"]);
  });

  it("transitions cleanly from notify discovery to automatic background download", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const notifyCheck = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: false,
    });
    expect(notifyCheck).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
    });

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const autoCheck = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: true,
    });
    expect(runtime.lastAutoDownload).toBe(true);
    expect(autoCheck).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
    });
  });

  it("clamps NaN and out-of-range download progress values safely", async () => {
    const progressEvents: Array<AppUpdateDownloadProgress | null> = [];
    const { runtime, service } = createService({
      bucket: async () => 0,
      onDownloadProgress: (progress) => progressEvents.push(progress),
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: true,
    });

    runtime.emitDownloadProgress({
      percent: Number.NaN,
      transferred: Number.NaN,
      total: Number.POSITIVE_INFINITY,
      bytesPerSecond: Number.NaN,
    });
    runtime.emitDownloadProgress({
      percent: 140,
      transferred: 200,
      total: 100,
      bytesPerSecond: 50,
    });

    expect(progressEvents).toContainEqual({
      version: "1.2.4",
      percent: 0,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
    });
    expect(progressEvents).toContainEqual({
      version: "1.2.4",
      percent: 100,
      transferred: 200,
      total: 100,
      bytesPerSecond: 50,
    });
  });

  it("applies updated updateMode after rollout bucket lookup before authorizing download", async () => {
    let mode: DesktopUpdateMode = "automatic";
    let resolveBucket!: (value: number) => void;
    const { runtime, service } = createService({
      bucket: () =>
        new Promise<number>((resolve) => {
          resolveBucket = resolve;
        }),
      updateMode: async () => mode,
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const check = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    await vi.waitFor(() => {
      expect(resolveBucket).toBeDefined();
    });
    mode = "notify";
    resolveBucket(0);
    const result = await check;

    expect(runtime.lastAutoDownload).toBe(false);
    expect(result).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: false,
      latestVersion: "1.2.4",
    });
  });

  it("skips a queued automatic check after Off is saved while an earlier check is in flight", async () => {
    let mode: DesktopUpdateMode = "automatic";
    const { runtime, service } = createService({
      bucket: async () => 0,
      updateMode: async () => mode,
    });
    const firstCheck = runtime.deferNextCheck();

    const firstPending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    const queuedPending = service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    await vi.waitFor(() => {
      expect(runtime.checkCount).toBe(1);
    });
    mode = "off";
    firstCheck.resolve({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    const [firstResult, queuedResult] = await Promise.all([firstPending, queuedPending]);
    expect(runtime.checkCount).toBe(1);
    expect(firstResult.hasUpdate).toBe(false);
    expect(queuedResult.hasUpdate).toBe(false);
  });

  it("falls back to automatic mode when reading updateMode fails so updates are never stranded", async () => {
    const settingsErrors: unknown[] = [];
    const { runtime, service } = createService({
      bucket: async () => 0,
      updateMode: async () => {
        throw new SyntaxError("Unexpected token } in JSON");
      },
      reportSettingsError: (error) => settingsErrors.push(error),
    });

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const autoResult = await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    expect(autoResult).toMatchObject({
      hasUpdate: true,
      downloading: true,
      latestVersion: "1.2.4",
      errorMessage: null,
    });

    runtime.finishUpdateDownload(rolledOutUpdate);
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const installedOnQuit = await service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });
    expect(installedOnQuit).toBe(true);
    expect(settingsErrors.length).toBeGreaterThan(0);
  });

  it("skips installUpdateOnQuit when updateMode is notify or off", async () => {
    let mode: DesktopUpdateMode = "automatic";
    const { runtime, service } = createService({
      bucket: async () => 0,
      updateMode: async () => mode,
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    mode = "notify";
    expect(
      await service.installUpdateOnQuit({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        signal: new AbortController().signal,
      }),
    ).toBe(false);

    mode = "off";
    expect(
      await service.installUpdateOnQuit({
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        signal: new AbortController().signal,
      }),
    ).toBe(false);

    expect(runtime.installedVersions).toEqual([]);
  });

  it("reports installer launch failures instead of success on both cached and downloaded paths", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });

    // Path 1: already downloaded, installer fails to launch
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
      autoDownload: true,
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    runtime.nextQuitAndInstallResult = {
      started: false,
      errorMessage: "EROFS: read-only file system",
    };
    const cachedFailure = await service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    expect(cachedFailure).toMatchObject({
      installed: false,
      errorMessage: "EROFS: read-only file system",
    });

    // Path 2: fresh download, installer fails to launch
    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    runtime.nextQuitAndInstallResult = {
      started: false,
      errorMessage: "Neither dpkg nor apt command found",
    };
    const freshFailure = await service.downloadAndInstallUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
    });
    expect(freshFailure).toMatchObject({
      installed: false,
      errorMessage: "Neither dpkg nor apt command found",
    });
  });
});

const HOUR_MS = 3_600_000;
const START = Date.parse("2026-04-28T12:00:00.000Z");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

/** A paced stable release whose rollout finished long before `START`. */
function pacedRelease(version: string): RuntimeUpdateInfo {
  return { version, releaseDate: "2026-04-20T00:00:00.000Z", rolloutHours: 18 };
}

/** A paced stable release published at `publishedAt`, so only its canary group is admitted. */
function newPacedRelease(version: string, publishedAt: number): RuntimeUpdateInfo {
  return { version, releaseDate: new Date(publishedAt).toISOString(), rolloutHours: 18 };
}

function emergencyRelease(version: string): RuntimeUpdateInfo {
  return { ...pacedRelease(version), rolloutHours: 0 };
}

interface RunningApp {
  runtime: FakeAppUpdateRuntime;
  /** Makes the release feed answer the next check with `release` as the latest release. */
  publish(release: RuntimeUpdateInfo): void;
  check(input?: {
    intent?: AppUpdateCheckIntent;
    releaseChannel?: AppReleaseChannel;
  }): Promise<AppUpdateCheckResult>;
  /** Finds `release` with an automatic check and finishes downloading it. */
  stage(release: RuntimeUpdateInfo): Promise<void>;
  quit(): Promise<boolean>;
}

function startApp(
  version: string,
  options?: {
    now?: () => number;
    bucket?: (version: string) => Promise<number>;
    pacing?: AppUpdatePacing;
    updateMode?: () => DesktopUpdateMode;
  },
): RunningApp {
  const { runtime, service } = createService({
    now: options?.now ?? (() => START),
    bucket: options?.bucket ?? (async () => 0),
    pacing: options?.pacing,
    updateMode: options?.updateMode,
  });
  const app: RunningApp = {
    runtime,
    publish(release) {
      // The updater reports the running version as "no update" before it asks
      // whether the install is admitted.
      runtime.nextCheck({ isUpdateAvailable: release.version !== version, updateInfo: release });
    },
    check(input) {
      return service.checkForAppUpdate({
        currentVersion: version,
        releaseChannel: input?.releaseChannel ?? "stable",
        intent: input?.intent ?? "automatic",
      });
    },
    async stage(release) {
      app.publish(release);
      const found = await app.check();
      expect(found).toMatchObject({ hasUpdate: true, latestVersion: release.version });
      runtime.finishUpdateDownload(release);
    },
    quit() {
      return service.installUpdateOnQuit({
        currentVersion: version,
        releaseChannel: "stable",
        signal: new AbortController().signal,
      });
    },
  };
  return app;
}

interface Install {
  now(): number;
  advance(ms: number): void;
  setClock(time: number): void;
  /** Starts the app again, as a new process would, on the given version. */
  launch(
    version: string,
    options?: {
      bucket?: (version: string) => Promise<number>;
      updateMode?: () => DesktopUpdateMode;
    },
  ): Promise<RunningApp>;
}

async function createInstall(): Promise<Install> {
  const userData = await mkdtemp(path.join(os.tmpdir(), "paseo-update-service-"));
  tempDirs.push(userData);
  let now = START;
  return {
    now: () => now,
    advance(ms) {
      now += ms;
    },
    setClock(time) {
      now = time;
    },
    async launch(version, options) {
      const pacing = createAppUpdatePacing({
        filePath: () => path.join(userData, "app-update-pacing.json"),
        currentVersion: () => version,
        now: () => now,
      });
      await pacing.start();
      return startApp(version, { ...options, now: () => now, pacing });
    },
  };
}

const noUpdate = {
  hasUpdate: false,
  readyToInstall: false,
  downloading: false,
  errorMessage: null,
};

describe("automatic check interval", () => {
  it("asks the release feed once per six hours", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.publish(pacedRelease("1.2.3"));
    app.publish(pacedRelease("1.2.3"));

    expect(await app.check()).toMatchObject(noUpdate);
    expect(app.runtime.checkCount).toBe(1);

    install.advance(AUTOMATIC_CHECK_INTERVAL_MS - 1);
    expect(await app.check()).toMatchObject(noUpdate);
    expect(app.runtime.checkCount).toBe(1);

    install.advance(1);
    expect(await app.check()).toMatchObject(noUpdate);
    expect(app.runtime.checkCount).toBe(2);
  });

  it("keeps the interval across a restart", async () => {
    const install = await createInstall();
    const firstRun = await install.launch("1.2.3");
    firstRun.publish(pacedRelease("1.2.3"));
    await firstRun.check();

    install.advance(HOUR_MS);
    const secondRun = await install.launch("1.2.3");
    secondRun.publish(pacedRelease("1.2.3"));
    expect(await secondRun.check()).toMatchObject(noUpdate);
    expect(secondRun.runtime.checkCount).toBe(0);

    install.advance(5 * HOUR_MS);
    await secondRun.check();
    expect(secondRun.runtime.checkCount).toBe(1);
  });

  it("checks again right after a failed check", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.runtime.failNextCheck(new Error("net::ERR_INTERNET_DISCONNECTED"));
    app.runtime.failNextCheck(new Error("502 Bad Gateway"));
    app.publish(pacedRelease("1.2.4"));

    expect((await app.check()).errorMessage).toBe("net::ERR_INTERNET_DISCONNECTED");
    expect((await app.check()).errorMessage).toBe("502 Bad Gateway");
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.4" });
    expect(app.runtime.checkCount).toBe(3);
  });

  it("checks again right after the release feed could not be read", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.runtime.nextCheck(null);
    app.publish(pacedRelease("1.2.4"));

    expect(await app.check()).toMatchObject(noUpdate);
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.4" });
    expect(app.runtime.checkCount).toBe(2);
  });

  it("checks again when the clock moved back", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.publish(pacedRelease("1.2.3"));
    await app.check();

    install.setClock(START - 30 * 24 * HOUR_MS);
    app.publish(pacedRelease("1.2.4"));
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.4" });
  });

  it("always runs a manual check", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.publish(pacedRelease("1.2.3"));
    await app.check();

    app.publish(pacedRelease("1.2.4"));
    expect(await app.check({ intent: "manual" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.2.4",
    });
    app.publish(pacedRelease("1.2.5"));
    expect(await app.check({ intent: "manual" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.2.5",
    });
    expect(app.runtime.checkCount).toBe(3);
  });

  it("does not let a manual check delay the next automatic check", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.publish(pacedRelease("1.2.3"));
    await app.check({ intent: "manual" });

    app.publish(pacedRelease("1.2.4"));
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.4" });
  });

  it("revalidates a staged update at quit inside the interval", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    // The release was halted: the feed points back at the running version.
    install.advance(HOUR_MS);
    app.publish(pacedRelease("1.2.3"));

    expect(await app.quit()).toBe(false);
    expect(app.runtime.checkCount).toBe(2);
    expect(app.runtime.installedVersions).toEqual([]);
  });

  it("installs a staged update at quit inside the interval", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    install.advance(HOUR_MS);
    app.publish(pacedRelease("1.2.4"));

    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.4"]);
  });

  it("makes no request while updates are off, then checks as soon as they are on", async () => {
    let mode: DesktopUpdateMode = "off";
    const install = await createInstall();
    const app = await install.launch("1.2.3", { updateMode: () => mode });
    app.publish(pacedRelease("1.2.4"));

    expect(await app.check()).toMatchObject(noUpdate);
    expect(app.runtime.checkCount).toBe(0);

    mode = "automatic";
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.4" });
    expect(app.runtime.checkCount).toBe(1);
  });

  it("does not space out checks on the beta channel", async () => {
    const install = await createInstall();
    const app = await install.launch("1.3.0-beta.1");
    app.publish(pacedRelease("1.3.0-beta.1"));
    app.publish(pacedRelease("1.3.0-beta.2"));

    await app.check({ releaseChannel: "beta" });
    expect(await app.check({ releaseChannel: "beta" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.3.0-beta.2",
    });
    expect(app.runtime.checkCount).toBe(2);
  });

  it("checks at once after the release channel changes", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    app.publish(pacedRelease("1.2.3"));
    await app.check();

    app.publish(pacedRelease("1.3.0-beta.1"));
    expect(await app.check({ releaseChannel: "beta" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.3.0-beta.1",
    });

    app.publish(pacedRelease("1.2.3"));
    expect(await app.check()).toMatchObject(noUpdate);
    expect(app.runtime.checkCount).toBe(3);

    await app.check();
    expect(app.runtime.checkCount).toBe(3);
  });

  it("reports an update being downloaded, then ready, without asking the feed again", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    const release = pacedRelease("1.2.4");
    app.publish(release);

    expect(await app.check()).toMatchObject({ hasUpdate: true, downloading: true });
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      latestVersion: "1.2.4",
      date: "2026-04-20T00:00:00.000Z",
    });

    app.runtime.finishUpdateDownload(release);
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: true,
      downloading: false,
      latestVersion: "1.2.4",
    });
    expect(app.runtime.checkCount).toBe(1);
  });

  it("retries a failed download at the next automatic check", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.3");
    const release = pacedRelease("1.2.4");
    app.publish(release);
    await app.check();
    app.runtime.failRuntime(new Error("ECONNRESET"));

    app.publish(release);
    await app.check();

    expect(app.runtime.checkCount).toBe(2);
  });

  it("keeps offering a found update in notify mode, and downloads it once automatic is chosen", async () => {
    let mode: DesktopUpdateMode = "notify";
    const install = await createInstall();
    const app = await install.launch("1.2.3", { updateMode: () => mode });
    const release = pacedRelease("1.2.4");
    app.publish(release);

    expect(await app.check()).toMatchObject({ hasUpdate: true, downloading: false });
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      downloading: false,
      latestVersion: "1.2.4",
    });
    expect(app.runtime.checkCount).toBe(1);

    mode = "automatic";
    app.publish(release);
    expect(await app.check()).toMatchObject({ hasUpdate: true, downloading: true });
    expect(app.runtime.checkCount).toBe(2);
  });
});

describe("update cooldown", () => {
  async function launchRightAfterUpdating(options?: {
    updateMode?: () => DesktopUpdateMode;
  }): Promise<{ install: Install; app: RunningApp }> {
    const install = await createInstall();
    await install.launch("1.2.3");
    const app = await install.launch("1.2.4", options);
    return { install, app };
  }

  it("defers a paced release for 24 hours after the app updated", async () => {
    const { install, app } = await launchRightAfterUpdating();

    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject(noUpdate);

    install.advance(UPDATE_COOLDOWN_MS - 1);
    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject(noUpdate);

    install.advance(AUTOMATIC_CHECK_INTERVAL_MS);
    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      downloading: true,
      latestVersion: "1.2.5",
    });
  });

  it("does not defer on the first launch that keeps pacing state", async () => {
    const install = await createInstall();
    const app = await install.launch("1.2.4");

    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.5" });
  });

  it("finds a paced release with a manual check during the cooldown", async () => {
    const { app } = await launchRightAfterUpdating();

    app.publish(pacedRelease("1.2.5"));
    expect(await app.check({ intent: "manual" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.2.5",
    });
  });

  it("delivers an emergency release during the cooldown", async () => {
    const { app } = await launchRightAfterUpdating();

    app.publish(emergencyRelease("1.2.5"));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      downloading: true,
      latestVersion: "1.2.5",
    });
  });

  it("delivers a release that has no rollout window during the cooldown", async () => {
    const { app } = await launchRightAfterUpdating();

    app.publish({ version: "1.2.5" });
    expect(await app.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.5" });
  });

  it("does not defer the beta channel", async () => {
    const { app } = await launchRightAfterUpdating();

    app.publish(pacedRelease("1.3.0-beta.1"));
    expect(await app.check({ releaseChannel: "beta" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.3.0-beta.1",
    });
  });

  it("defers the notify-mode prompt the same way", async () => {
    const { install, app } = await launchRightAfterUpdating({ updateMode: () => "notify" });

    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject(noUpdate);

    install.advance(UPDATE_COOLDOWN_MS);
    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      downloading: false,
      latestVersion: "1.2.5",
    });
  });

  it("installs at quit an update the user asked for during the cooldown", async () => {
    const { app } = await launchRightAfterUpdating();
    const release = pacedRelease("1.2.5");
    app.publish(release);
    await app.check({ intent: "manual" });
    app.runtime.finishUpdateDownload(release);

    app.publish(release);
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.5"]);
  });
});

describe("staged update", () => {
  it("is kept when the next paced release ships", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    app.publish(pacedRelease("1.2.5"));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: true,
      downloading: false,
      latestVersion: "1.2.4",
    });
    expect(app.runtime.checkCount).toBe(2);

    app.publish(pacedRelease("1.2.5"));
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.4"]);
    expect(app.runtime.requestedDownloadVersions).toEqual([]);
  });

  it("is installed at quit when the next paced release shipped since the last check", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    app.publish(pacedRelease("1.2.5"));
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.4"]);
  });

  it("is kept through a run of paced releases seen one after the other", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    for (const next of ["1.2.5", "1.2.6", "1.2.7"]) {
      app.publish(pacedRelease(next));
      expect(await app.check()).toMatchObject({ readyToInstall: true, latestVersion: "1.2.4" });
    }

    app.publish(pacedRelease("1.2.7"));
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.4"]);
  });

  it("is dropped when a release was missed and the newest one is not admitted yet", async () => {
    const app = startApp("1.2.3", { bucket: async (version) => (version === "1.2.4" ? 0 : 0.99) });
    await app.stage(pacedRelease("1.2.4"));
    app.publish(pacedRelease("1.2.5"));
    await app.check();

    // 1.2.6 was never seen. It may have been the fix for a bad 1.2.4.
    app.publish(newPacedRelease("1.2.7", START));
    expect(await app.check()).toMatchObject(noUpdate);

    app.publish(newPacedRelease("1.2.7", START));
    expect(await app.quit()).toBe(false);
    expect(app.runtime.installedVersions).toEqual([]);
  });

  it("is replaced when a release was missed and the newest one is admitted", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    app.publish(pacedRelease("1.2.6"));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      latestVersion: "1.2.6",
    });
  });

  it("is not held against a minor release, which may follow a patch this install never saw", async () => {
    const app = startApp("1.2.3", { bucket: async (version) => (version === "1.2.4" ? 0 : 0.99) });
    await app.stage(pacedRelease("1.2.4"));

    // 1.2.5 may have shipped as the fix for a bad 1.2.4 before 1.3.0.
    app.publish(newPacedRelease("1.3.0", START));
    expect(await app.check()).toMatchObject(noUpdate);

    app.publish(newPacedRelease("1.3.0", START));
    expect(await app.quit()).toBe(false);
    expect(app.runtime.installedVersions).toEqual([]);
  });

  it("does not hold a download that finished after a newer release was admitted", async () => {
    const app = startApp("1.2.3");
    const first = pacedRelease("1.2.4");
    const second = pacedRelease("1.2.5");
    app.publish(first);
    await app.check();
    app.publish(second);
    await app.check();
    app.runtime.finishUpdateDownload(first);

    app.publish(second);
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      latestVersion: "1.2.5",
    });

    app.publish(second);
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.5"]);
  });

  it("is replaced by an emergency release", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    const hotfix = emergencyRelease("1.2.5");
    app.publish(hotfix);
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      downloading: true,
      latestVersion: "1.2.5",
    });

    app.runtime.finishUpdateDownload(hotfix);
    app.publish(hotfix);
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.5"]);
  });

  it("is dropped when the emergency release that follows it cannot be installed on this system", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    // The updater refuses a release whose minimum system version is too new.
    app.runtime.nextCheck({ isUpdateAvailable: false, updateInfo: emergencyRelease("1.2.5") });
    expect(await app.check()).toMatchObject(noUpdate);
    expect(await app.quit()).toBe(false);
  });

  it("is replaced by an emergency release first seen at quit", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    app.publish(emergencyRelease("1.2.5"));
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.5"]);
  });

  it("is replaced when the release it was held against becomes an emergency release", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));
    app.publish(pacedRelease("1.2.5"));
    await app.check();

    app.publish(emergencyRelease("1.2.5"));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      latestVersion: "1.2.5",
    });
  });

  it("is replaced by a manual check that finds the next release", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    app.publish(pacedRelease("1.2.5"));
    expect(await app.check({ intent: "manual" })).toMatchObject({
      hasUpdate: true,
      readyToInstall: false,
      latestVersion: "1.2.5",
    });
  });

  it("is dropped when its release is halted", async () => {
    const app = startApp("1.2.3");
    await app.stage(pacedRelease("1.2.4"));

    app.publish(pacedRelease("1.2.3"));
    expect(await app.check()).toMatchObject(noUpdate);

    app.publish(pacedRelease("1.2.3"));
    expect(await app.quit()).toBe(false);
    expect(app.runtime.installedVersions).toEqual([]);
  });

  it("is kept when the release it was held against is halted", async () => {
    const app = startApp("1.2.3");
    const release = pacedRelease("1.2.4");
    await app.stage(release);
    app.publish(pacedRelease("1.2.5"));
    await app.check();

    app.publish(release);
    expect(await app.check()).toMatchObject({ readyToInstall: true, latestVersion: "1.2.4" });

    app.publish(release);
    expect(await app.quit()).toBe(true);
    expect(app.runtime.installedVersions).toEqual(["1.2.4"]);
  });
});

describe("rollout admission", () => {
  it("places the install on each release's own rollout", async () => {
    const bucket = async (version: string) => (version === "1.2.4" ? 0 : 0.99);

    const first = startApp("1.2.3", { bucket });
    first.publish(newPacedRelease("1.2.4", START));
    expect(await first.check()).toMatchObject({ hasUpdate: true, latestVersion: "1.2.4" });

    const second = startApp("1.2.3", { bucket });
    second.publish(newPacedRelease("1.2.5", START));
    expect(await second.check()).toMatchObject(noUpdate);
  });

  it("admits a paced release when the install's rollout position cannot be read", async () => {
    const app = startApp("1.2.3", {
      bucket: async () => {
        throw new Error("EACCES: permission denied, open '.updaterId'");
      },
    });

    app.publish(newPacedRelease("1.2.4", START));
    expect(await app.check()).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.2.4",
      errorMessage: null,
    });
  });

  it("runs a manual check without the install's rollout position", async () => {
    const app = startApp("1.2.3", {
      bucket: async () => {
        throw new Error("EACCES: permission denied, open '.updaterId'");
      },
    });

    app.publish(newPacedRelease("1.2.4", START));
    expect(await app.check({ intent: "manual" })).toMatchObject({
      hasUpdate: true,
      latestVersion: "1.2.4",
      errorMessage: null,
    });
  });
});
