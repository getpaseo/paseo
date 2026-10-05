import type {
  AppUpdateInstallRequest,
  AppUpdateRuntime,
  AppUpdateRuntimeConfiguration,
  RuntimeUpdateCheckResult,
  RuntimeUpdateInfo,
} from "./app-update-service.js";

export class FakeAppUpdateRuntime implements AppUpdateRuntime {
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
    cancel(): void;
  } | null = null;
  checkCount = 0;
  downloadCallCount = 0;
  cancelCount = 0;
  requestedDownloadVersions: string[] = [];
  downloadedVersions: string[] = [];
  installedVersions: string[] = [];
  installModes: Array<{ targetVersion: string; isSilent: boolean; isForceRunAfter: boolean }> = [];

  get hasActiveDownload(): boolean {
    return this.activeDownload !== null;
  }

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

  beginUpdateDownload(
    info: RuntimeUpdateInfo,
    options?: { announce?: boolean },
  ): {
    resolve(): void;
    reject(error: Error): void;
  } {
    this.downloadableUpdate = info;
    if (options?.announce !== false) this.prepareUpdate(info);
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
      cancel: () => {
        this.activeDownload = null;
        rejectPromise(new Error("Download cancelled."));
      },
    };
    this.activeDownload = activeDownload;
    return { resolve: activeDownload.resolve, reject: activeDownload.reject };
  }

  cancelDownload(): void {
    const active = this.activeDownload;
    if (!active) return;
    this.cancelCount += 1;
    active.cancel();
  }

  async checkForUpdates(): Promise<{
    isUpdateAvailable: boolean;
    updateInfo: RuntimeUpdateInfo;
  } | null> {
    this.checkCount += 1;
    const result = this.checks.shift() ?? null;
    if (result instanceof Error) throw result;
    if (result && "kind" in result) {
      if (result.kind === "check-error") {
        if (result.emitRuntimeError) {
          this.configuration?.onError(result.error);
        }
        throw result.error;
      }
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
