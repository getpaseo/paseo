import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listDiskHostBrowserProxyPartitions,
  listPaseoBrowserProfileGuests,
  readHostBrowserProxyPartitions,
  readLegacyPaseoBrowserIds,
} from "./browser-profile.js";
import { getHostBrowserProxyPartition } from "./browser-proxy/partition.js";

class FakeProfileSession {
  public readonly storageClears: unknown[] = [];
  public cacheClears = 0;
  public authClears = 0;
  public storageClear: Promise<void> = Promise.resolve();

  public clearStorageData(options: unknown): Promise<void> {
    this.storageClears.push(options);
    return this.storageClear;
  }

  public clearCache(): Promise<void> {
    this.cacheClears += 1;
    return Promise.resolve();
  }

  public clearAuthCache(): Promise<void> {
    this.authClears += 1;
    return Promise.resolve();
  }
}

class FakeLiveGuest {
  public reloads = 0;

  public constructor(
    public readonly id: number,
    private readonly destroyed = false,
    private readonly reloadError: Error | null = null,
  ) {}

  public isDestroyed(): boolean {
    return this.destroyed;
  }

  public reload(): void {
    if (this.reloadError) {
      throw this.reloadError;
    }
    this.reloads += 1;
  }
}

class FakeWebContents extends FakeLiveGuest {
  public constructor(
    id: number,
    public readonly session: object,
    private readonly type: string,
    destroyed = false,
  ) {
    super(id, destroyed);
  }

  public getType(): string {
    return this.type;
  }
}

describe("listPaseoBrowserProfileGuests", () => {
  test("returns every live webview and popup in the shared profile", () => {
    const profileSession = {};
    const firstWindowGuest = new FakeWebContents(1, profileSession, "webview");
    const secondWindowGuest = new FakeWebContents(2, profileSession, "webview");
    const foreignProfileGuest = new FakeWebContents(3, {}, "webview");
    const popupWindow = new FakeWebContents(4, profileSession, "window");
    const destroyedGuest = new FakeWebContents(5, profileSession, "webview", true);

    const guests = listPaseoBrowserProfileGuests({
      profileSession,
      webContents: [
        firstWindowGuest,
        secondWindowGuest,
        foreignProfileGuest,
        popupWindow,
        destroyedGuest,
      ],
    });

    expect(guests).toEqual([firstWindowGuest, secondWindowGuest, popupWindow]);
  });

  test("returns live guests across both local and host proxy sessions", () => {
    const localSession = {};
    const hostSession = {};
    const localGuest = new FakeWebContents(1, localSession, "webview");
    const hostGuest = new FakeWebContents(2, hostSession, "webview");
    const hostPopup = new FakeWebContents(3, hostSession, "window");
    const foreignGuest = new FakeWebContents(4, {}, "webview");

    const guests = listPaseoBrowserProfileGuests({
      profileSessions: [localSession, hostSession],
      webContents: [localGuest, hostGuest, hostPopup, foreignGuest],
    });

    expect(guests).toEqual([localGuest, hostGuest, hostPopup]);
  });
});

describe("host browser proxy partitions cleanup", () => {
  test("discovers persisted host proxy partitions from userData and includes them in profile sessions", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "paseo-profile-test-"));
    try {
      const diskPartition = getHostBrowserProxyPartition("disk-host");
      const dirName = diskPartition.replace(/^persist:/, "");
      mkdirSync(path.join(tmpDir, "Partitions", dirName), { recursive: true });
      mkdirSync(path.join(tmpDir, "Partitions", "paseo-browser"), { recursive: true });
      mkdirSync(path.join(tmpDir, "Partitions", "unrelated-partition"), { recursive: true });

      expect(listDiskHostBrowserProxyPartitions(tmpDir)).toEqual([diskPartition]);

      const derived = readHostBrowserProxyPartitions(["runtime-host", diskPartition, "", 42]);
      const expectedRuntimePartition = getHostBrowserProxyPartition("runtime-host");
      expect(derived).toEqual([expectedRuntimePartition, diskPartition]);

      const requested: string[] = [];
      getPaseoBrowserProfileSessions(
        {
          fromPartition: (partition) => {
            requested.push(partition);
            return new FakeProfileSession();
          },
        },
        [],
        [...derived, diskPartition, "persist:foreign"],
      );

      expect(requested).toEqual(["persist:paseo-browser", expectedRuntimePartition, diskPartition]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("legacy browser profiles", () => {
  test("accepts only unique saved browser ids and resolves their old partitions", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const fallbackId = "1700000000000-abcd";
    const browserIds = readLegacyPaseoBrowserIds([uuid, fallbackId, uuid, "not-a-browser-id", 123]);
    const partitions: string[] = [];
    const sessions = getPaseoBrowserProfileSessions(
      {
        fromPartition: (partition) => {
          partitions.push(partition);
          return new FakeProfileSession();
        },
      },
      browserIds,
    );

    expect(partitions).toEqual([
      "persist:paseo-browser",
      `persist:paseo-browser-${uuid}`,
      `persist:paseo-browser-${fallbackId}`,
    ]);
    expect(sessions).toHaveLength(3);
  });

  test("resolves one valid legacy profile for tab-close cleanup", () => {
    const partitions: string[] = [];
    const sessions = {
      fromPartition: (partition: string) => {
        partitions.push(partition);
        return new FakeProfileSession();
      },
    };

    expect(getLegacyPaseoBrowserProfileSession(sessions, "1700000000000-abcd")).not.toBeNull();
    expect(getLegacyPaseoBrowserProfileSession(sessions, "invalid")).toBeNull();
    expect(partitions).toEqual(["persist:paseo-browser-1700000000000-abcd"]);
  });
});

describe("clearPaseoBrowserProfile", () => {
  test("clears site data, HTTP cache, and auth before reloading live guests", async () => {
    const profile = new FakeProfileSession();
    const legacyProfile = new FakeProfileSession();
    let finishStorageClear: (() => void) | null = null;
    profile.storageClear = new Promise((resolve) => {
      finishStorageClear = resolve;
    });
    const firstGuest = new FakeLiveGuest(1);
    const secondGuest = new FakeLiveGuest(2);

    const clearing = clearPaseoBrowserProfile({
      profileSessions: [profile, legacyProfile],
      listGuests: () => [firstGuest, secondGuest],
      logReloadError: () => {},
    });

    expect(firstGuest.reloads).toBe(0);
    expect(secondGuest.reloads).toBe(0);
    finishStorageClear?.();
    await clearing;

    expect(profile.storageClears).toEqual([
      {
        storages: [
          "cookies",
          "filesystem",
          "indexdb",
          "localstorage",
          "serviceworkers",
          "cachestorage",
          "shadercache",
        ],
      },
    ]);
    expect(profile.cacheClears).toBe(1);
    expect(profile.authClears).toBe(1);
    expect(legacyProfile.storageClears).toEqual(profile.storageClears);
    expect(legacyProfile.cacheClears).toBe(1);
    expect(legacyProfile.authClears).toBe(1);
    expect(firstGuest.reloads).toBe(1);
    expect(secondGuest.reloads).toBe(1);
  });

  test("skips destroyed guests and logs individual reload failures", async () => {
    const profile = new FakeProfileSession();
    const destroyedGuest = new FakeLiveGuest(1, true);
    const reloadError = new Error("guest disappeared");
    const failedGuest = new FakeLiveGuest(2, false, reloadError);
    const reloadErrors: Array<{ guestId: number; error: unknown }> = [];

    await clearPaseoBrowserProfile({
      profileSessions: [profile],
      listGuests: () => [destroyedGuest, failedGuest],
      logReloadError: (guestId, error) => reloadErrors.push({ guestId, error }),
    });

    expect(destroyedGuest.reloads).toBe(0);
    expect(failedGuest.reloads).toBe(0);
    expect(reloadErrors).toEqual([{ guestId: 2, error: reloadError }]);
  });

  test("propagates clear failures without reloading guests", async () => {
    const profile = new FakeProfileSession();
    const clearError = new Error("profile locked");
    profile.storageClear = Promise.reject(clearError);
    const guest = new FakeLiveGuest(1);

    await expect(
      clearPaseoBrowserProfile({
        profileSessions: [profile],
        listGuests: () => [guest],
        logReloadError: () => {},
      }),
    ).rejects.toBe(clearError);
    expect(guest.reloads).toBe(0);
  });
});
