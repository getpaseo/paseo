import { describe, expect, it } from "vitest";

import { createAppUpdateService } from "./app-update-service";
import { FakeAppUpdateRuntime } from "./fake-app-update-runtime";

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
    expect(runtime.installModes).toEqual([
      { targetVersion: "1.2.5", isSilent: true, isForceRunAfter: false },
    ]);
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

  it("keeps the downloaded update when the before-quit wait is cancelled", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    let finishWait!: (proceed: boolean) => void;
    const waiting = new Promise<boolean>((resolve) => {
      finishWait = resolve;
    });
    const installing = service.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      () => waiting,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.installedVersions).toEqual([]);
    finishWait(false);
    expect(await installing).toMatchObject({ installed: false });
    expect(runtime.installedVersions).toEqual([]);
  });

  it("cancels a download that is still running", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    runtime.beginUpdateDownload(rolledOutUpdate);
    const controller = new AbortController();
    const installing = service.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable", signal: controller.signal },
      async () => true,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(installing).resolves.toMatchObject({ installed: false, cancelled: true });
    expect(runtime.installedVersions).toEqual([]);
    expect(runtime.cancelCount).toBe(1);
    expect(runtime.hasActiveDownload).toBe(false);
  });

  it("keeps a quit-time download running when the deadline passes", async () => {
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
    runtime.beginUpdateDownload(newerUpdate, { announce: false });
    const deadline = new AbortController();
    const pending = service.installUpdateOnQuit({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: deadline.signal,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    deadline.abort();

    await expect(pending).resolves.toBe(false);
    expect(runtime.downloadCallCount).toBeGreaterThan(0);
    expect(runtime.cancelCount).toBe(0);
    expect(runtime.hasActiveDownload).toBe(true);
    expect(runtime.installedVersions).toEqual([]);
  });

  it("installs only after the before-quit idle check allows it", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    let finishWait!: (proceed: boolean) => void;
    const waiting = new Promise<boolean>((resolve) => {
      finishWait = resolve;
    });
    const installing = service.downloadAndInstallUpdate(
      { currentVersion: "1.2.3", releaseChannel: "stable" },
      () => waiting,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runtime.installedVersions).toEqual([]);
    finishWait(true);
    expect(await installing).toMatchObject({ installed: true });
    expect(runtime.installedVersions).toEqual([rolledOutUpdate.version]);
  });

  it("propagates an idle check failure without installing", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await expect(
      service.downloadAndInstallUpdate(
        { currentVersion: "1.2.3", releaseChannel: "stable" },
        async () => {
          throw new Error("Cannot verify agent activity");
        },
      ),
    ).rejects.toThrow("Cannot verify agent activity");
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
