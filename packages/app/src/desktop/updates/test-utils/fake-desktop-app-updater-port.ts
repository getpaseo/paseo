import type {
  DesktopAppUpdateCheckResult,
  DesktopAppUpdateInstallResult,
  DesktopReleaseChannel,
} from "@/desktop/updates/desktop-updates";
import type { DesktopAppUpdaterPort } from "@/desktop/updates/desktop-app-updater";

export interface FakeDesktopAppUpdaterPort extends DesktopAppUpdaterPort {
  readonly recordedChecks: Array<{ releaseChannel: DesktopReleaseChannel }>;
  readonly recordedInstalls: Array<{ releaseChannel: DesktopReleaseChannel }>;
  nextCheckResult(result: DesktopAppUpdateCheckResult): void;
  deferNextCheck(): {
    resolve(result: DesktopAppUpdateCheckResult): void;
    reject(error: unknown): void;
  };
  failNextCheck(error: unknown): void;
  nextInstallResult(result: DesktopAppUpdateInstallResult): void;
  failNextInstall(error: unknown): void;
}

type CheckOutcome =
  | { kind: "result"; result: DesktopAppUpdateCheckResult }
  | { kind: "error"; error: unknown }
  | { kind: "deferred"; promise: Promise<DesktopAppUpdateCheckResult> };

type InstallOutcome =
  | { kind: "result"; result: DesktopAppUpdateInstallResult }
  | { kind: "error"; error: unknown };

function buildCheckResult(
  overrides: Partial<DesktopAppUpdateCheckResult> = {},
): DesktopAppUpdateCheckResult {
  return {
    hasUpdate: false,
    readyToInstall: false,
    currentVersion: null,
    latestVersion: null,
    body: null,
    date: null,
    ...overrides,
  };
}

function buildInstallResult(
  overrides: Partial<DesktopAppUpdateInstallResult> = {},
): DesktopAppUpdateInstallResult {
  return {
    installed: false,
    version: null,
    message: "Update completed.",
    ...overrides,
  };
}

export function createFakeDesktopAppUpdaterPort(): FakeDesktopAppUpdaterPort {
  const recordedChecks: Array<{ releaseChannel: DesktopReleaseChannel }> = [];
  const recordedInstalls: Array<{ releaseChannel: DesktopReleaseChannel }> = [];
  const checkOutcomes: CheckOutcome[] = [];
  const installOutcomes: InstallOutcome[] = [];

  return {
    recordedChecks,
    recordedInstalls,
    nextCheckResult(result) {
      checkOutcomes.push({ kind: "result", result });
    },
    deferNextCheck() {
      let resolve!: (value: DesktopAppUpdateCheckResult) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<DesktopAppUpdateCheckResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      checkOutcomes.push({ kind: "deferred", promise });
      return { resolve, reject };
    },
    failNextCheck(error) {
      checkOutcomes.push({ kind: "error", error });
    },
    nextInstallResult(result) {
      installOutcomes.push({ kind: "result", result });
    },
    failNextInstall(error) {
      installOutcomes.push({ kind: "error", error });
    },
    async checkDesktopAppUpdate(input) {
      recordedChecks.push(input);
      const outcome = checkOutcomes.shift();
      if (!outcome) {
        return buildCheckResult();
      }
      if (outcome.kind === "result") {
        return outcome.result;
      }
      if (outcome.kind === "error") {
        throw outcome.error;
      }
      return outcome.promise;
    },
    async installDesktopAppUpdate(input) {
      recordedInstalls.push(input);
      const outcome = installOutcomes.shift();
      if (!outcome) {
        return buildInstallResult();
      }
      if (outcome.kind === "result") {
        return outcome.result;
      }
      throw outcome.error;
    },
  };
}

export function buildFakeCheckResult(
  overrides: Partial<DesktopAppUpdateCheckResult> = {},
): DesktopAppUpdateCheckResult {
  return buildCheckResult(overrides);
}

export function buildFakeInstallResult(
  overrides: Partial<DesktopAppUpdateInstallResult> = {},
): DesktopAppUpdateInstallResult {
  return buildInstallResult(overrides);
}
