import { describe, expect, test } from "vitest";
import {
  encryptBrowserBackup,
  decryptBrowserBackup,
  readBrowserSessionCookies,
  writeBrowserSessionCookies,
} from "./browser-backup.js";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  clearPaseoBrowserProfile,
  getLegacyPaseoBrowserProfileSession,
  getPaseoBrowserProfileSessions,
  listPaseoBrowserProfileGuests,
  readLegacyPaseoBrowserIds,
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

describe("encrypted browser backup", () => {
  const data = {
    version: 1 as const,
    cookies: [
      {
        name: "sid",
        value: "synthetic-session",
        domain: "example.test",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
      },
    ],
    logins: [
      { origin: "https://example.test", username: "fixture-user", password: "synthetic-login" },
    ],
  };
  test("roundtrips cookies and credentials and rejects a wrong passphrase, tampering and a short passphrase", async () => {
    const encrypted = await encryptBrowserBackup(data, "a synthetic passphrase");
    expect(encrypted).not.toContain("synthetic-session");
    expect(encrypted).not.toContain("synthetic-login");
    expect(await decryptBrowserBackup(encrypted, "a synthetic passphrase")).toEqual(data);
    await expect(decryptBrowserBackup(encrypted, "wrong synthetic passphrase")).rejects.toThrow(
      /No data was restored/,
    );
    const tampered = JSON.parse(encrypted);
    tampered.tag = Buffer.alloc(16).toString("base64");
    await expect(
      decryptBrowserBackup(JSON.stringify(tampered), "a synthetic passphrase"),
    ).rejects.toThrow(/No data was restored/);
    await expect(encryptBrowserBackup(data, "short")).rejects.toThrow(/12–1024/);
  });
  test("keeps session cookies encrypted with private permissions across instances and fails closed without OS encryption", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paseo-session-fixture-"));
    const file = join(dir, "session.enc");
    const key = randomBytes(32);
    const crypto = {
      isAvailable: () => true,
      encrypt: (plain: string) => {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decrypt: (encrypted: Buffer) => {
        const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(0, 12));
        decipher.setAuthTag(encrypted.subarray(12, 28));
        return Buffer.concat([
          decipher.update(encrypted.subarray(28)),
          decipher.final(),
        ]).toString();
      },
    };
    try {
      await writeBrowserSessionCookies(file, data.cookies, crypto);
      expect(readFileSync(file).includes(Buffer.from("synthetic-session"))).toBe(false);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(await readBrowserSessionCookies(file, crypto)).toEqual(data.cookies);
      await expect(
        writeBrowserSessionCookies(file, [], { ...crypto, isAvailable: () => false }),
      ).rejects.toThrow(/Unlock/);
      expect(await readBrowserSessionCookies(file, crypto)).toEqual(data.cookies);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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
