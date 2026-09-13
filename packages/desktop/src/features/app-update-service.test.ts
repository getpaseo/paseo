import { describe, expect, it } from "vitest";

import {
  createAppUpdateService,
  type AppUpdateInstallRequest,
  type AppUpdateRuntime,
  type AppUpdateRuntimeConfiguration,
  type PendingUpdateStore,
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
  requestedDownloadVersions: string[] = [];
  downloadedVersions: string[] = [];
  installedVersions: string[] = [];
  installModes: Array<{ targetVersion: string; isSilent: boolean; isForceRunAfter: boolean }> = [];

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

  quitAndInstall({ targetVersion, isSilent, isForceRunAfter }: AppUpdateInstallRequest): void {
    if (this.downloadedUpdate) {
      this.installedVersions.push(this.downloadedUpdate.version);
      this.installModes.push({ targetVersion, isSilent, isForceRunAfter });
    }
  }
}

interface FakePendingUpdateStore extends PendingUpdateStore {
  current(): string | null;
  /** Every write() call, in the order it was issued. */
  writes(): string[];
  /** Number of writes that have finished. */
  completedWrites(): number;
  /** Number of writes whose store call is still outstanding. */
  inFlightWrites(): number;
  /** Holds every subsequent write until released. One gate for all calls. */
  gateWrites(): { release(): void; fail(error: Error): void };
}

function createFakePendingUpdateStore(initialVersion: string | null): FakePendingUpdateStore {
  let version = initialVersion;
  const issued: string[] = [];
  let completed = 0;
  let inFlight = 0;
  let gate: {
    promise: Promise<void>;
    release(): void;
    fail(error: Error): void;
  } | null = null;
  return {
    read: async () => version,
    write: async (next: string) => {
      issued.push(next);
      inFlight += 1;
      try {
        if (gate) await gate.promise;
        version = next;
      } finally {
        inFlight -= 1;
      }
      completed += 1;
    },
    clear: async () => {
      version = null;
    },
    current: () => version,
    writes: () => [...issued],
    completedWrites: () => completed,
    inFlightWrites: () => inFlight,
    gateWrites() {
      let release!: () => void;
      let fail!: (error: Error) => void;
      const promise = new Promise<void>((resolve, reject) => {
        release = () => {
          gate = null;
          resolve();
        };
        fail = (error) => {
          gate = null;
          reject(error);
        };
      });
      promise.catch(() => undefined);
      gate = { promise, release, fail };
      return { release, fail };
    },
  };
}

/** Drains pending microtasks so chained promise work has run. */
function settleMicrotasks(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Resolves when `signal` aborts, so tests pick the exact abort point. */
function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function createService(input?: {
  now?: () => number;
  bucket?: () => Promise<number>;
  pendingVersion?: string | null;
}) {
  const runtime = new FakeAppUpdateRuntime();
  const pendingUpdateStore = createFakePendingUpdateStore(input?.pendingVersion ?? null);
  const installErrors: string[] = [];
  const service = createAppUpdateService({
    runtime,
    isPackaged: () => true,
    now: input?.now ?? (() => Date.parse("2026-04-28T12:00:00.000Z")),
    bucket: input?.bucket ?? (async () => 0.99),
    pendingUpdateStore,
    reportInstallError: (message) => {
      installErrors.push(message);
    },
  });
  return { runtime, service, pendingUpdateStore, installErrors };
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

  it("installs the recorded pending update silently and forces a relaunch", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    const events: string[] = [];
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const result = await service.installPendingUpdateOnStartup(
      {
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        signal: new AbortController().signal,
      },
      async () => {
        events.push("stop-daemon");
      },
    );

    expect(result).toEqual({ installed: true, version: "1.2.4" });
    expect(events).toEqual(["stop-daemon"]);
    expect(runtime.installedVersions).toEqual(["1.2.4"]);
    expect(runtime.installModes).toEqual([
      { targetVersion: "1.2.4", isSilent: true, isForceRunAfter: true },
    ]);
    expect(pendingUpdateStore.current()).toBeNull();
  });

  it("abandons the startup install when the deadline aborts during daemon stop", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const deadline = new AbortController();
    const stopEntered = createDeferred<void>();
    const pending = service.installPendingUpdateOnStartup(
      {
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        signal: deadline.signal,
      },
      async (signal: AbortSignal) => {
        stopEntered.resolve();
        await waitForAbort(signal);
      },
    );

    await stopEntered.promise;
    deadline.abort();
    const result = await pending;

    expect(result).toEqual({ installed: false, reason: "timeout" });
    expect(runtime.installedVersions).toEqual([]);
    expect(pendingUpdateStore.current()).toBe("1.2.4");
  });

  it("installs once the daemon stops before the deadline", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });
    runtime.finishUpdateDownload(rolledOutUpdate);

    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    const result = await service.installPendingUpdateOnStartup(
      {
        currentVersion: "1.2.3",
        releaseChannel: "stable",
        signal: new AbortController().signal,
      },
      async () => {},
    );

    expect(result).toEqual({ installed: true, version: "1.2.4" });
    expect(runtime.installedVersions).toEqual(["1.2.4"]);
    expect(pendingUpdateStore.current()).toBeNull();
  });

  it("never asks electron-updater anything when no pending update is recorded", async () => {
    const { runtime, service } = createService({ bucket: async () => 0 });

    const result = await service.installPendingUpdateOnStartup({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ installed: false, reason: "no-update" });
    expect(runtime.checkCount).toBe(0);
    expect(runtime.installedVersions).toEqual([]);
  });

  it("does not install a pending update that is not ready before the deadline", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });

    const deadline = new AbortController();
    const pending = service.installPendingUpdateOnStartup({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: deadline.signal,
    });
    await settleMicrotasks();
    deadline.abort();

    expect(await pending).toEqual({ installed: false, reason: "timeout" });
    expect(runtime.installedVersions).toEqual([]);
    expect(pendingUpdateStore.current()).toBe("1.2.4");
  });

  it("ignores a pending record that a newer release has superseded", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.nextCheck({
      isUpdateAvailable: true,
      updateInfo: { ...rolledOutUpdate, version: "1.2.5" },
    });

    const result = await service.installPendingUpdateOnStartup({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ installed: false, reason: "no-update" });
    expect(runtime.installedVersions).toEqual([]);
    expect(pendingUpdateStore.current()).toBe("1.2.4");
  });

  it("clears a stale pending record when the manifest no longer offers it", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.nextCheck(null);

    const result = await service.installPendingUpdateOnStartup({
      currentVersion: "1.2.4",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ installed: false, reason: "no-update" });
    expect(pendingUpdateStore.current()).toBeNull();
  });

  it("keeps the pending record when the startup check fails", async () => {
    const { runtime, service, pendingUpdateStore } = createService({
      bucket: async () => 0,
      pendingVersion: "1.2.4",
    });
    runtime.failNextCheck(new Error("offline"));

    const result = await service.installPendingUpdateOnStartup({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ installed: false, reason: "not-ready" });
    expect(runtime.installedVersions).toEqual([]);
    expect(pendingUpdateStore.current()).toBe("1.2.4");
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
    await settleMicrotasks();
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

describe("pending update persistence", () => {
  it("keeps a pending write observable until it settles", async () => {
    const { runtime, service, pendingUpdateStore } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    const gate = pendingUpdateStore.gateWrites();
    runtime.finishUpdateDownload(rolledOutUpdate);
    await settleMicrotasks();

    // The download event has fired, but the marker write is parked on the gate.
    expect(pendingUpdateStore.current()).toBeNull();
    expect(pendingUpdateStore.inFlightWrites()).toBe(1);
    let flushed = false;
    const flush = service.flushPendingUpdate().then(() => {
      flushed = true;
      return undefined;
    });
    await settleMicrotasks();
    expect(flushed).toBe(false);

    gate.release();
    await flush;

    expect(flushed).toBe(true);
    expect(pendingUpdateStore.current()).toBe("1.2.4");
  });

  it("chains consecutive downloads so the flush covers every write and the newest wins", async () => {
    const { runtime, service, pendingUpdateStore } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    const gate = pendingUpdateStore.gateWrites();
    const newerUpdate = { ...rolledOutUpdate, version: "1.2.5" };
    runtime.finishUpdateDownload(rolledOutUpdate);
    runtime.finishUpdateDownload(newerUpdate);
    await settleMicrotasks();

    // The newest download is chained behind the in-flight one, so only the first
    // marker has reached the store and the writes never overlap.
    expect(pendingUpdateStore.writes()).toEqual(["1.2.4"]);
    expect(pendingUpdateStore.inFlightWrites()).toBe(1);

    const flush = service.flushPendingUpdate();
    gate.release();
    await flush;

    expect(pendingUpdateStore.writes()).toEqual(["1.2.4", "1.2.5"]);
    expect(pendingUpdateStore.completedWrites()).toBe(2);
    expect(pendingUpdateStore.current()).toBe("1.2.5");
  });

  it("resolves flush after a failed write without throwing", async () => {
    const { runtime, service, pendingUpdateStore, installErrors } = createService({
      bucket: async () => 0,
    });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    const gate = pendingUpdateStore.gateWrites();
    runtime.finishUpdateDownload(rolledOutUpdate);
    await settleMicrotasks();
    expect(pendingUpdateStore.inFlightWrites()).toBe(1);
    gate.fail(new Error("disk full"));

    await expect(service.flushPendingUpdate()).resolves.toBeUndefined();
    expect(pendingUpdateStore.current()).toBeNull();
    expect(installErrors.some((message) => message.includes("disk full"))).toBe(true);
  });

  it("does not consider the download settled until the marker write completes", async () => {
    const { runtime, service, pendingUpdateStore } = createService({ bucket: async () => 0 });
    runtime.nextCheck({ isUpdateAvailable: true, updateInfo: rolledOutUpdate });
    await service.checkForAppUpdate({
      currentVersion: "1.2.3",
      releaseChannel: "stable",
      intent: "automatic",
    });

    const gate = pendingUpdateStore.gateWrites();
    const download = runtime.beginUpdateDownload(rolledOutUpdate);
    download.resolve();
    // electron-updater resolves downloadUpdate() as soon as the download event
    // dispatches, so the caller must flush the marker before exiting.
    await settleMicrotasks();
    expect(pendingUpdateStore.current()).toBeNull();

    gate.release();
    await service.flushPendingUpdate();
    expect(pendingUpdateStore.current()).toBe("1.2.4");
  });
});
