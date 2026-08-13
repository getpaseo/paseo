import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assertSupportedNodeVersion, openDatabase } from "./open.js";
import { runInTransaction } from "./transaction.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "paseo-db-test-"));
  homes.push(home);
  return home;
}

function insertThenFail(database: ReturnType<typeof openDatabase>): void {
  runInTransaction(database, () => {
    database
      .prepare("INSERT INTO push_tokens (token, payload) VALUES (?, ?)")
      .run("token", JSON.stringify({ token: "token" }));
    throw new Error("stop");
  });
}

describe("openDatabase", () => {
  test("creates and configures the migrated database", async () => {
    const home = await createHome();
    const database = openDatabase(home);
    try {
      expect(existsSync(join(home, "paseo.db"))).toBe(true);
      expect(database.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      expect(database.prepare("PRAGMA foreign_keys").get()).toMatchObject({ foreign_keys: 1 });
      expect(database.prepare("PRAGMA busy_timeout").get()).toMatchObject({ timeout: 5_000 });
      expect(database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 3 });
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "legacy_imports" }),
          expect.objectContaining({ name: "push_tokens" }),
          expect.objectContaining({ name: "schedules" }),
        ]),
      );
    } finally {
      database.close();
    }
  });

  test("rejects runtimes older than Node 22.20", () => {
    expect(() => assertSupportedNodeVersion("22.19.9")).toThrow("Paseo requires Node.js >=22.20.0");
    expect(() => assertSupportedNodeVersion("22.20.0")).not.toThrow();
    expect(() => assertSupportedNodeVersion("23.0.0")).not.toThrow();
  });

  test("rolls back failed transactions", async () => {
    const home = await createHome();
    const database = openDatabase(home);
    try {
      expect(() => insertThenFail(database)).toThrow("stop");
      expect(database.prepare("SELECT count(*) AS count FROM push_tokens").get()).toMatchObject({
        count: 0,
      });
    } finally {
      database.close();
    }
  });
});
