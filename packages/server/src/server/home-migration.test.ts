import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { migrateLegacyHome } from "./home-migration.js";
import { resolvePaseoHome } from "./paseo-home.js";
import { acquirePidLock, releasePidLock } from "./pid-lock.js";

describe("migrateLegacyHome", () => {
  let homeDir: string;
  let legacyHome: string;
  let home: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(tmpdir(), "paseo-home-migration-"));
    legacyHome = path.join(homeDir, ".paseo");
    home = path.join(homeDir, ".pandaos");
  });

  // POSIX keeps a relative link; Windows uses a junction, which always stores the absolute target.
  const expectedLinkTarget = () => (process.platform === "win32" ? home : ".pandaos");

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  async function seedLegacyHome() {
    await mkdir(path.join(legacyHome, "worktrees", "abc", "slug"), { recursive: true });
    await writeFile(path.join(legacyHome, "config.json"), '{"version":1}');
  }

  test("moves the legacy home and leaves a symlink that keeps old paths valid", async () => {
    await seedLegacyHome();

    const result = await migrateLegacyHome({ homeDir });

    expect(result).toEqual({ action: "migrated", legacyHome, home, dryRun: false });
    expect((await lstat(home)).isDirectory()).toBe(true);
    expect((await lstat(legacyHome)).isSymbolicLink()).toBe(true);
    expect(await readlink(legacyHome)).toBe(expectedLinkTarget());
    expect(await readFile(path.join(legacyHome, "config.json"), "utf8")).toBe('{"version":1}');
    expect((await lstat(path.join(legacyHome, "worktrees", "abc", "slug"))).isDirectory()).toBe(
      true,
    );
    expect(resolvePaseoHome({}, homeDir)).toBe(home);
  });

  test("is idempotent", async () => {
    await seedLegacyHome();
    await migrateLegacyHome({ homeDir });

    const again = await migrateLegacyHome({ homeDir });

    expect(again.action).toBe("already_migrated");
    expect(await readlink(legacyHome)).toBe(expectedLinkTarget());
  });

  test("dry run reports the plan and changes nothing", async () => {
    await seedLegacyHome();

    const result = await migrateLegacyHome({ homeDir, dryRun: true });

    expect(result).toEqual({ action: "would_migrate", legacyHome, home, dryRun: true });
    expect((await lstat(legacyHome)).isDirectory()).toBe(true);
    await expect(lstat(home)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses while a daemon holds the legacy home", async () => {
    await seedLegacyHome();
    await acquirePidLock(legacyHome, null);
    try {
      await expect(migrateLegacyHome({ homeDir })).rejects.toMatchObject({
        code: "DAEMON_RUNNING",
      });
      await expect(migrateLegacyHome({ homeDir, dryRun: true })).rejects.toMatchObject({
        code: "DAEMON_RUNNING",
      });
      expect((await lstat(legacyHome)).isDirectory()).toBe(true);
    } finally {
      await releasePidLock(legacyHome);
    }
  });

  test("refuses when both homes are real directories", async () => {
    await seedLegacyHome();
    await mkdir(home);

    await expect(migrateLegacyHome({ homeDir })).rejects.toMatchObject({
      code: "BOTH_HOMES_EXIST",
    });
    expect((await lstat(legacyHome)).isDirectory()).toBe(true);
  });

  test("refuses a legacy symlink that points elsewhere", async () => {
    const elsewhere = path.join(homeDir, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, legacyHome);

    await expect(migrateLegacyHome({ homeDir })).rejects.toMatchObject({
      code: "LEGACY_HOME_NOT_DIRECTORY",
    });
  });

  test("reports nothing to migrate on a fresh install", async () => {
    expect((await migrateLegacyHome({ homeDir })).action).toBe("nothing_to_migrate");
    await expect(lstat(legacyHome)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
