import { describe, expect, it } from "vitest";

import {
  createAppUpdateService,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
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
  checkCount = 0;
  downloadCallCount = 0;
  downloadedVersions: string[] = [];
  installedVersions: string[] = [];
  installModes: Array<{ isSilent: boolean; isForceRunAfter: boolean }> = [];

  configure(input: AppUpdateRuntimeConfiguration): void {
    this.configuration = input;
    this.gate = input.shouldAdmitUpdate;
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

  async downloadUpdate(): Promise<void> {
    this.downloadCallCount += 1;
    if (this.activeDownload) {
      return this.activeDownload.promise;
    }
    if (this.downloadableUpdate) {
      this.finishUpdateDownload(this.downloadableUpdate);
    }
  }

  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void {
    if (this.downloadedUpdate) {
      this.installedVersions.push(this.downloadedUpdate.version);
      this.installModes.push({ isSilent, isForceRunAfter });
    }
  }
}

function createService(input?: { now?: () => number; bucket?: () => Promise<number> }) {
  const runtime = new FakeAppUpdateRuntime();
  const service = createAppUpdateService({
    runtime,
    isPackaged: () => true,
    now: input?.now ?? (() => Date.parse("2026-04-28T12:00:00.000Z")),
    bucket: input?.bucket ?? (async () => 0.99),
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
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
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

    await Promise.resolve();
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
      currentVersion: "1.2.3",
      latestVersion: "1.2.5",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });

  it("replaces a downloaded update when a newer release is admitted", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

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
      currentVersion: "1.2.3",
      latestVersion: "1.2.5",
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

    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
    const installed = await service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(installed).toBe(true);
    expect(runtime.installedVersions).toEqual(["1.2.5"]);
    expect(runtime.installModes).toEqual([{ isSilent: true, isForceRunAfter: false }]);
  });

  it("does not install an older download while its replacement is still rolling out", async () => {
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

    const newerUpdate = {
      ...rolledOutUpdate,
      version: "1.2.5",
      releaseDate: "2026-04-28T12:00:00.000Z",
    };
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: newerUpdate });
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
    expect(runtime.installModes).toEqual([{ isSilent: false, isForceRunAfter: true }]);
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
      currentVersion: "1.2.3",
      latestVersion: "1.2.4",
      body: null,
      date: "2026-04-28T00:00:00.000Z",
      errorMessage: null,
    });
  });
});
