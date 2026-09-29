import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { seedSharedProfile } from "./playwright-host.js";

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
