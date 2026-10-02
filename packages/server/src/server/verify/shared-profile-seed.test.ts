import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedSharedProfile } from "./playwright-host.js";
import { ProfileCookieSecrets } from "./profile-secrets.js";

function profile(root: string, workspace: string, marker: string, ageSeconds: number): void {
  const dir = path.join(root, workspace, "default", "Default");
  mkdirSync(path.join(root, workspace, "default", "Cache"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "Cookies"), marker);
  writeFileSync(path.join(root, workspace, "default", "SingletonLock"), "lock");
  const time = Date.now() / 1000 - ageSeconds;
  utimesSync(path.join(dir, "Cookies"), time, time);
}

describe("seedSharedProfile", () => {
  it("encrypts the legacy import cache before removal and refuses to overwrite it when the keyring is locked", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "profile-secrets-"));
    const legacy = path.join(dir, "imported-cookies.json");
    const encrypted = path.join(dir, "imported-cookies.enc");
    const data = {
      version: "fixture",
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
    };
    try {
      writeFileSync(legacy, JSON.stringify(data));
      const locked = new ProfileCookieSecrets(async () => {
        throw new Error("locked");
      });
      await expect(locked.migrate(legacy, encrypted)).rejects.toThrow("locked");
      expect(existsSync(legacy)).toBe(true);
      expect(existsSync(encrypted)).toBe(false);
      const secrets = new ProfileCookieSecrets(async () => Buffer.alloc(32, 2));
      await secrets.migrate(legacy, encrypted);
      expect(existsSync(legacy)).toBe(false);
      expect(readFileSync(encrypted).includes(Buffer.from("synthetic-session"))).toBe(false);
      expect(statSync(encrypted).mode & 0o777).toBe(0o600);
      expect(
        await new ProfileCookieSecrets(async () => Buffer.alloc(32, 2)).read(encrypted),
      ).toEqual(data);
      await expect(
        new ProfileCookieSecrets(async () => Buffer.alloc(32, 3)).read(encrypted),
      ).rejects.toThrow(/could not be decrypted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("starts the shared profile from the most recently used workspace profile, without caches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "profiles-"));
    profile(root, "wks_old", "old-login", 3600);
    profile(root, "wks_new", "new-login", 10);
    const userDataDir = path.join(root, "shared", "default");

    seedSharedProfile({ profilesRoot: root, userDataDir, profile: "default" });

    expect(readFileSync(path.join(userDataDir, "Default", "Cookies"), "utf8")).toBe("new-login");
    expect(existsSync(path.join(userDataDir, "Cache"))).toBe(false);
    expect(existsSync(path.join(userDataDir, "SingletonLock"))).toBe(false);
  });

  it("leaves an existing shared profile alone", () => {
    const root = mkdtempSync(path.join(tmpdir(), "profiles-"));
    profile(root, "wks_new", "new-login", 10);
    const userDataDir = path.join(root, "shared", "default");
    mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
    writeFileSync(path.join(userDataDir, "Default", "Cookies"), "shared-login");

    seedSharedProfile({ profilesRoot: root, userDataDir, profile: "default" });

    expect(readFileSync(path.join(userDataDir, "Default", "Cookies"), "utf8")).toBe("shared-login");
  });
});
