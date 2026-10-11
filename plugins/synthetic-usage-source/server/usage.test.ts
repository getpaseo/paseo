import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}
interface TestSqliteModule {
  DatabaseSync: new (path: string) => TestSqliteDatabase;
}

const envKeys = [
  "HOME",
  "USERPROFILE",
  "XDG_DATA_HOME",
  "OPENCODE_DB",
  "PASEO_SYNTHETIC_API_KEY",
  "SYNTHETIC_API_KEY",
] as const;

describe("Synthetic usage source", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let homeDir: string;

  beforeEach(async () => {
    originalEnv = { ...process.env };
    for (const key of envKeys) delete process.env[key];
    homeDir = await mkdtemp(join(tmpdir(), "synthetic-usage-source-"));
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env = originalEnv;
    await rm(homeDir, { recursive: true, force: true });
  });

  test("discovers daemon credentials globally and for Synthetic model sessions", async () => {
    process.env.PASEO_SYNTHETIC_API_KEY = "synthetic-key";
    const global = await discover({ kind: "global" });
    const session = await discover({
      kind: "session",
      provider: "opencode",
      model: "synthetic/claude-sonnet",
      env: {},
    });

    expect(global).toHaveLength(1);
    expect(global[0]?.harness).toBe("Synthetic");
    expect(global[0]?.key).not.toContain("synthetic-key");
    expect(session).toEqual(global);
    await expect(
      discover({ kind: "session", provider: "opencode", model: "openai/gpt-5", env: {} }),
    ).resolves.toEqual([]);
  });

  test("prefers the Paseo environment key over the generic key", async () => {
    process.env.PASEO_SYNTHETIC_API_KEY = "paseo-key";
    process.env.SYNTHETIC_API_KEY = "generic-key";
    const fetchApi = vi.fn(async () =>
      Response.json({
        subscription: { requests: 5, limit: 100, renewsAt: "2026-10-08T00:00:00Z" },
      }),
    );

    const [account] = await discover({ kind: "global" });
    const report = await fetchUsage(account?.input, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer paseo-key" }),
      }),
    );
    expect(report).toMatchObject({
      status: "available",
      windows: [{ id: "five_hour", label: "5 hours", usedPct: 5 }],
      details: [{ id: "requests", value: "5 / 100" }],
    });
  });

  test("reads OpenCode's selected v2 credential through a read-only database", async () => {
    const dataHome = join(homeDir, "xdg");
    const databasePath = join(dataHome, "opencode", "custom.db");
    await mkdir(dirname(databasePath), { recursive: true });
    const sqliteSpecifier: string = "node:sqlite";
    const sqlite: TestSqliteModule = await import(sqliteSpecifier);
    const db = new sqlite.DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)",
    );
    const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)");
    insert.run("old", "synthetic", 0, 100, JSON.stringify({ type: "key", key: "old-key" }));
    insert.run("active", "synthetic", 1, 200, JSON.stringify({ type: "key", key: "selected-key" }));
    insert.run(
      "other",
      "other-provider",
      1,
      300,
      JSON.stringify({ type: "key", key: "other-key" }),
    );
    db.close();
    process.env.XDG_DATA_HOME = dataHome;
    process.env.OPENCODE_DB = "custom.db";

    const [account] = await discover({ kind: "global" });
    const fetchApi = vi.fn(async () =>
      Response.json({
        rollingFiveHourLimit: {
          nextTickAt: "2026-10-07T20:00:00Z",
          remaining: 720.2,
          max: 750,
        },
        weeklyTokenLimit: { percentRemaining: 40, nextRegenAt: "2026-10-08T00:00:00Z" },
        subscription: { requests: 1, limit: 100, renewsAt: "2026-10-08T00:00:00Z" },
      }),
    );

    const report = await fetchUsage(account?.input, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer selected-key" }),
      }),
    );
    expect(report).toMatchObject({
      status: "available",
      windows: [
        {
          id: "five_hour",
          usedPct: expect.closeTo(3.9733, 4),
          resetsAt: "2026-10-07T20:00:00Z",
        },
        { id: "weekly", usedPct: 60, resetsAt: "2026-10-08T00:00:00Z" },
      ],
      details: [{ value: "29.8 / 750" }],
    });
  });

  test("honors an absolute OpenCode database override", async () => {
    const databasePath = join(homeDir, "custom-location", "synthetic.db");
    await mkdir(dirname(databasePath), { recursive: true });
    const sqliteSpecifier: string = "node:sqlite";
    const sqlite: TestSqliteModule = await import(sqliteSpecifier);
    const db = new sqlite.DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)",
    );
    db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)").run(
      "active",
      "synthetic",
      1,
      200,
      JSON.stringify({ type: "key", key: "absolute-key" }),
    );
    db.close();
    process.env.OPENCODE_DB = databasePath;

    const [account] = await discover({ kind: "global" });
    const fetchApi = vi.fn(async () =>
      Response.json({
        subscription: { requests: 1, limit: 100, renewsAt: "2026-10-08T00:00:00Z" },
      }),
    );
    await fetchUsage(account?.input, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer absolute-key" }),
      }),
    );
  });

  test("uses the legacy auth file when OpenCode has no v2 credential", async () => {
    const directory = join(homeDir, ".local", "share", "opencode");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({ synthetic: { type: "api", key: "legacy-key" } }),
    );

    const [account] = await discover({ kind: "global" });
    const fetchApi = vi.fn(async () =>
      Response.json({
        subscription: { requests: 1, limit: 100, renewsAt: "2026-10-08T00:00:00Z" },
      }),
    );
    await fetchUsage(account?.input, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.synthetic.new/v2/quotas",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer legacy-key" }),
      }),
    );
  });

  test("does not fall back to the legacy account after an invalid selected credential", async () => {
    const directory = join(homeDir, ".local", "share", "opencode");
    const databasePath = join(directory, "opencode.db");
    await mkdir(directory, { recursive: true });
    const sqliteSpecifier: string = "node:sqlite";
    const sqlite: TestSqliteModule = await import(sqliteSpecifier);
    const db = new sqlite.DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, active INTEGER, time_created INTEGER, value TEXT)",
    );
    db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)").run(
      "active",
      "synthetic",
      1,
      200,
      JSON.stringify({ type: "oauth", access: "wrong-account" }),
    );
    db.close();
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({ synthetic: { type: "api", key: "legacy-key" } }),
    );

    const [account] = await discover({ kind: "global" });
    const fetchApi = vi.fn();
    await expect(fetchUsage(account?.input, fetchApi)).resolves.toMatchObject({
      status: "error",
      error: "Could not read Synthetic credentials from OpenCode",
    });
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
