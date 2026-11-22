import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  listBrowserPartitionDirectories,
} from "./browser-profile.js";

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
  test("reloads live webviews and popups across cleared profiles", async () => {
    const profileSession = {};
    const firstWindowGuest = new FakeWebContents(1, profileSession, "webview");
    const scopedSession = new FakeProfileSession();
    const secondWindowGuest = new FakeWebContents(2, scopedSession, "webview");
    const foreignProfileGuest = new FakeWebContents(3, {}, "webview");
    const popupWindow = new FakeWebContents(4, profileSession, "window");
    const destroyedGuest = new FakeWebContents(5, profileSession, "webview", true);

    const guests = listPaseoBrowserProfileGuests({
      profileSessions: new Set([profileSession, scopedSession]),
      webContents: [
        firstWindowGuest,
        secondWindowGuest,
        foreignProfileGuest,
        popupWindow,
        destroyedGuest,
      ],
    });

    expect(guests).toEqual([firstWindowGuest, secondWindowGuest, popupWindow]);
    await clearPaseoBrowserProfile({
      profileSessions: [scopedSession],
      listGuests: () => guests,
      logReloadError: () => {},
    });
    expect(secondWindowGuest.reloads).toBe(1);
  });
});

describe("legacy browser profiles", () => {
  test("opens only on-disk profiles plus the sessions of live guests", () => {
    const uuid = "123e4567-e89b-42d3-a456-426614174000";
    const partitions: string[] = [];
    const live = new FakeProfileSession();
    const sessions = getPaseoBrowserProfileSessions(
      {
        fromPartition: (partition) => {
          partitions.push(partition);
          return new FakeProfileSession();
        },
      },
      [
        "paseo-shared-work",
        `paseo-project-${"a".repeat(32)}-customer`,
        `paseo-project-${"a".repeat(32)}-ws-${"b".repeat(32)}`,
        "paseo-browser-scope-invalid",
        "foreign",
        `paseo-browser-${uuid}`,
      ],
      [live, live],
    );

    // A modern tab ID without a directory is never opened, so no empty partition is created.
    expect(partitions).toEqual([
      "persist:paseo-browser",
      "persist:paseo-shared-work",
      `persist:paseo-project-${"a".repeat(32)}-customer`,
      `persist:paseo-project-${"a".repeat(32)}-ws-${"b".repeat(32)}`,
      `persist:paseo-browser-${uuid}`,
    ]);
    expect(sessions).toHaveLength(6);
    expect(sessions.at(-1)).toBe(live);
  });

  test("clears and reloads a live guest whose new profile is not on disk yet", async () => {
    const live = new FakeProfileSession();
    const guest = new FakeWebContents(9, live, "webview");
    const profileSessions = getPaseoBrowserProfileSessions(
      { fromPartition: () => new FakeProfileSession() },
      [],
      [live],
    );
    await clearPaseoBrowserProfile({
      profileSessions,
      listGuests: () =>
        listPaseoBrowserProfileGuests({
          profileSessions: new Set(profileSessions),
          webContents: [guest],
        }),
      logReloadError: () => {},
    });
    expect(live.storageClears).toHaveLength(1);
    expect(guest.reloads).toBe(1);
  });

  test("resolves a legacy profile for tab-close cleanup only when it exists on disk", () => {
    const partitions: string[] = [];
    const sessions = {
      fromPartition: (partition: string) => {
        partitions.push(partition);
        return new FakeProfileSession();
      },
    };
    const directories = ["paseo-browser-1700000000000-abcd"];

    expect(
      getLegacyPaseoBrowserProfileSession(sessions, "1700000000000-abcd", directories),
    ).not.toBeNull();
    expect(
      getLegacyPaseoBrowserProfileSession(sessions, "1700000000001-ef", directories),
    ).toBeNull();
    expect(
      getLegacyPaseoBrowserProfileSession(sessions, "invalid", ["paseo-browser-invalid"]),
    ).toBeNull();
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

test("disk discovery includes closed named, automatic and old per-tab sessions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "browser-partitions-"));
  const project = "paseo-project-" + "a".repeat(32);
  const names = [
    "paseo-shared-work",
    project + "-customer",
    project + "-ws-" + "b".repeat(32),
    "paseo-browser-1700000000001-ef",
  ];
  const opened: string[] = [];
  try {
    expect(await listBrowserPartitionDirectories(directory)).toEqual([]);
    for (const name of [...names, "unrelated"])
      await mkdir(path.join(directory, "Partitions", name), { recursive: true });
    await writeFile(path.join(directory, "Partitions", "paseo-shared-file"), "");
    getPaseoBrowserProfileSessions(
      {
        fromPartition(partition) {
          opened.push(partition);
          return new FakeProfileSession();
        },
      },
      await listBrowserPartitionDirectories(directory),
    );
    expect(opened.sort()).toEqual(
      ["persist:paseo-browser", ...names.map((name) => "persist:" + name)].sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
