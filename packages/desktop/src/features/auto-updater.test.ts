import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UUID } from "builder-util-runtime";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(),
  },
}));

vi.mock("electron-updater", () => ({
  get autoUpdater() {
    throw new Error("autoUpdater accessed before the update runtime is configured");
  },
}));

import {
  bucketFromStagingUserId,
  ElectronAppUpdateRuntime,
  type ElectronUpdaterRuntime,
  resolveStagingUserId,
  rolloutManifestSchema,
  shouldAdmitToRollout,
  shouldInstallAppUpdateOnQuit,
} from "./auto-updater";

class FakeElectronUpdater implements ElectronUpdaterRuntime {
  allowDowngrade = false;
  allowPrerelease = false;
  autoDownload = false;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = true;
  channel: string | null = null;
  isUserWithinRollout: ElectronUpdaterRuntime["isUserWithinRollout"] = async () => true;
  loggedErrors: unknown[] = [];
  logger: ElectronUpdaterRuntime["logger"] = {
    debug: () => undefined,
    error: (message) => this.loggedErrors.push(message),
    info: () => undefined,
    warn: () => undefined,
  };

  private readonly handlers = new Map<string, unknown>();
  private nextCheckError: Error | null = null;

  on: ElectronUpdaterRuntime["on"] = ((event: string, handler: unknown) => {
    this.handlers.set(event, handler);
    return this;
  }) as ElectronUpdaterRuntime["on"];

  checkForUpdates: ElectronUpdaterRuntime["checkForUpdates"] = async () => {
    if (this.nextCheckError) {
      const error = this.nextCheckError;
      this.nextCheckError = null;
      throw error;
    }
    return null;
  };

  downloadUpdate: ElectronUpdaterRuntime["downloadUpdate"] = async () => [];
  quitAndInstall: ElectronUpdaterRuntime["quitAndInstall"] = () => undefined;

  emitError(error: Error): void {
    const handler = this.handlers.get("error") as ((value: Error) => void) | undefined;
    handler?.(error);
  }

  logInternalError(error: Error): void {
    this.logger?.error(error);
  }

  rejectNextCheck(error: Error): void {
    this.nextCheckError = error;
  }
}

function createElectronRuntime() {
  const updater = new FakeElectronUpdater();
  const runtime = new ElectronAppUpdateRuntime(updater);
  const onError = vi.fn();
  runtime.configure({
    releaseChannel: "stable",
    shouldAdmitUpdate: () => true,
    onUpdateAvailable: vi.fn(),
    onUpdateDownloaded: vi.fn(),
    onUpdateNotAvailable: vi.fn(),
    onError,
  });
  return { onError, runtime, updater };
}

describe("ElectronAppUpdateRuntime", () => {
  it("treats an unpublished channel manifest as an unavailable update", async () => {
    const { onError, runtime, updater } = createElectronRuntime();
    const error = Object.assign(new Error("Cannot find latest-mac.yml"), {
      code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND",
    });
    updater.logInternalError(error);
    updater.emitError(error);
    updater.rejectNextCheck(error);

    await expect(runtime.checkForUpdates()).resolves.toBeNull();
    expect(updater.loggedErrors).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("keeps genuine updater failures visible", async () => {
    const { onError, runtime, updater } = createElectronRuntime();
    const error = new Error("network down");
    updater.emitError(error);
    updater.rejectNextCheck(error);

    await expect(runtime.checkForUpdates()).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
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

describe("shouldAdmitToRollout", () => {
  it("admits beta, missing rollout hours, zero-hour rollout, and missing release date", () => {
    expect(
      shouldAdmitToRollout({
        channel: "beta",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: undefined,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 0,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: undefined,
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("blocks future releases and respects the linear threshold mid-rollout", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T02:00:00.000Z",
        now: Date.parse("2026-04-28T01:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.49,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.51,
      }),
    ).toBe(false);
  });

  it("blocks the bucket-zero client at exact release time, admits as soon as time advances", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.000Z"),
        bucket: 0,
      }),
    ).toBe(false);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-28T00:00:00.001Z"),
        bucket: 0,
      }),
    ).toBe(true);
  });

  it("admits the highest-bucket client at and past the rollout end", () => {
    const maxBucket = (0x100000000 - 1) / 0x100000000;
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2026-04-29T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "2026-04-28T00:00:00.000Z",
        now: Date.parse("2027-04-28T00:00:00.000Z"),
        bucket: maxBucket,
      }),
    ).toBe(true);
  });

  it("admits when releaseDate is unparseable", () => {
    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: 24,
        releaseDate: "not a date",
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("treats garbage manifest rollout fields as missing and admits", () => {
    const parsed = rolloutManifestSchema.parse({
      rolloutHours: "not a number",
      releaseDate: 12345,
    });

    expect(
      shouldAdmitToRollout({
        channel: "stable",
        rolloutHours: parsed.rolloutHours,
        releaseDate: parsed.releaseDate,
        now: Date.parse("2026-04-28T12:00:00.000Z"),
        bucket: 0.99,
      }),
    ).toBe(true);
  });

  it("maps the maximum 32-bit slot to a bucket strictly less than 1", () => {
    const allOnes = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const allZeros = "00000000-0000-0000-0000-000000000000";
    expect(bucketFromStagingUserId(allOnes)).toBeLessThan(1);
    expect(bucketFromStagingUserId(allOnes)).toBeGreaterThan(0.999);
    expect(bucketFromStagingUserId(allZeros)).toBe(0);
  });

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
