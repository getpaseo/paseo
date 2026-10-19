import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import { defaultStorePaths } from "./stores.js";

import { inputSchema } from "../shared/input.js";

let fixtureDirectory: string;
let fixturePath: string;
function stores(path: string) {
  return { file: path, database: join(dirname(path), "opencode.db") };
}
async function database() {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(fixtureDirectory, "opencode.db"));
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER)",
  );
  return db;
}
beforeEach(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "go-default-"));
  fixturePath = join(fixtureDirectory, "auth.json");
  await writeFile(
    fixturePath,
    JSON.stringify({ "opencode-go": { type: "api", key: "fixture-secret" } }),
  );
});
afterEach(async () => {
  await rm(fixtureDirectory, { recursive: true, force: true });
});

test("discovery input rejects an explicit API key", () => {
  expect(inputSchema.safeParse({ apiKey: "unused" }).success).toBe(false);
  expect(
    inputSchema.safeParse({ store: "database", path: "opencode.db", apiKey: "unused" }).success,
  ).toBe(false);
  expect(() => inputSchema.parse({})).toThrow();
});

const upstreamResponse = {
  usage: {
    rolling: { status: "ok", percent: 21, resetsAt: "2026-09-26T20:00:00.000Z" },
    weekly: { status: "ok", percent: 42, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-01T00:00:00.000Z" },
  },
};

test("uses the active v2 Go key instead of a stale legacy key without writing either store", async () => {
  const databasePath = join(fixtureDirectory, "opencode.db");
  const db = await database();
  const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)");
  insert.run("inactive", "opencode-go", JSON.stringify({ type: "key", key: "inactive-key" }), 0, 3);
  insert.run("active", "opencode-go", JSON.stringify({ type: "key", key: "active-key" }), 1, 1);
  insert.run("zen", "opencode", JSON.stringify({ type: "key", key: "zen-key" }), 1, 4);
  db.close();
  const beforeDatabase = await readFile(databasePath);
  const beforeFile = await readFile(fixturePath);
  const accounts = await discover(stores(fixturePath));
  expect(accounts).toEqual([
    {
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: { store: "database", path: databasePath },
    },
  ]);
  const input = inputSchema.parse(accounts[0]!.input);
  const report = await fetchUsage(input, async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer active-key");
    return Response.json(upstreamResponse);
  });
  expect(report.status).toBe("available");
  expect(report.windows.map((window) => window.usedPct)).toEqual([21, 42, 100]);
  expect(await readFile(databasePath)).toEqual(beforeDatabase);
  expect(await readFile(fixturePath)).toEqual(beforeFile);
});

test("discovers v2 Go usage without a legacy auth.json", async () => {
  const db = await database();
  db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)").run(
    "go",
    "opencode-go",
    JSON.stringify({ type: "key", key: "database-key" }),
    1,
    1,
  );
  db.close();
  await rm(fixturePath);
  const accounts = await discover(stores(fixturePath));
  expect(accounts).toEqual([
    {
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: { store: "database", path: join(fixtureDirectory, "opencode.db") },
    },
  ]);
  expect(JSON.stringify(accounts)).not.toContain("database-key");
});

test("refresh follows the active Go account and re-reads its rotated key", async () => {
  const db = await database();
  const insert = db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)");
  insert.run("first", "opencode-go", JSON.stringify({ type: "key", key: "first-key" }), 1, 1);
  insert.run("second", "opencode-go", JSON.stringify({ type: "key", key: "second-key" }), 0, 2);
  db.close();
  const paths = stores(fixturePath);
  const accounts = await discover(paths);
  const input = inputSchema.parse(accounts[0]!.input);
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(paths.database);
  writer.exec("UPDATE credential SET active = CASE id WHEN 'second' THEN 1 ELSE 0 END");
  writer
    .prepare("UPDATE credential SET value = ? WHERE id = 'second'")
    .run(JSON.stringify({ type: "key", key: "rotated-key" }));
  writer.close();
  expect(await discover(paths)).toEqual(accounts);
  const before = await readFile(paths.database);
  const report = await fetchUsage(input, async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer rotated-key");
    return Response.json(upstreamResponse);
  });
  expect(report.status).toBe("available");
  expect(JSON.stringify(report)).not.toContain("rotated-key");
  expect(await readFile(paths.database)).toEqual(before);
});

test.each([
  ["inactive Go key", "opencode-go", 0, JSON.stringify({ type: "key", key: "inactive-key" })],
  ["other provider", "opencode", 1, JSON.stringify({ type: "key", key: "zen-key" })],
  ["Console OAuth", "opencode-go", 1, JSON.stringify({ type: "oauth", access: "oauth-token" })],
  ["malformed credential", "opencode-go", 1, "invalid JSON"],
  ["empty key", "opencode-go", 1, JSON.stringify({ type: "key", key: "" })],
])(
  "does not revive a legacy key for a v2 store with %s",
  async (_name, provider, active, value) => {
    const db = await database();
    db.prepare("INSERT INTO credential VALUES (?, ?, ?, ?, ?)").run(
      "credential",
      provider,
      value,
      active,
      1,
    );
    db.close();
    expect(await discover(stores(fixturePath))).toEqual([]);
  },
);

test("keeps legacy discovery when the v1 session database has no credential table", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(fixtureDirectory, "opencode.db"));
  db.exec("CREATE TABLE session (id TEXT PRIMARY KEY)");
  db.close();
  expect(await discover(stores(fixturePath))).toEqual([
    {
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: { store: "file", path: fixturePath },
    },
  ]);
});

test("fails before fetching when the selected database disappears", async () => {
  await expect(
    fetchUsage({ store: "database", path: join(fixtureDirectory, "missing.db") }, async () => {
      throw new Error("must not fetch");
    }),
  ).rejects.toThrow("login store no longer exists");
});

test("resolves default and overridden OpenCode store paths", () => {
  expect(defaultStorePaths({ HOME: fixtureDirectory })).toEqual({
    file: join(fixtureDirectory, ".local", "share", "opencode", "auth.json"),
    database: join(fixtureDirectory, ".local", "share", "opencode", "opencode.db"),
  });
  const customDatabase = join(fixtureDirectory, "custom.db");
  expect(
    defaultStorePaths({ XDG_DATA_HOME: fixtureDirectory, OPENCODE_DB: customDatabase }),
  ).toEqual({
    file: join(fixtureDirectory, "opencode", "auth.json"),
    database: customDatabase,
  });
});

test("discovers and fetches the default key from read-only auth.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-usage-"));
  const path = join(directory, "auth.json");
  const content = JSON.stringify({ "opencode-go": { type: "api", key: "fixture-key" } });
  try {
    await writeFile(path, content);
    expect(await discover(stores(path))).toEqual([
      { key: expect.stringMatching(/^[a-f0-9]{64}$/), input: { store: "file", path } },
    ]);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json(upstreamResponse);
    };
    const report = await fetchUsage({ store: "file", path }, fetchApi);
    expect(requests).toEqual([
      { url: "https://opencode.ai/zen/go/v1/usage", authorization: "Bearer fixture-key" },
    ]);
    expect(report.status).toBe("available");
    expect(report.windows.map((window) => [window.id, window.usedPct, window.resetsAt])).toEqual([
      ["rolling", 21, "2026-09-26T20:00:00.000Z"],
      ["weekly", 42, "2026-09-28T00:00:00.000Z"],
      ["monthly", 100, "2026-10-01T00:00:00.000Z"],
    ]);
    // The rolling window's length is not reported, so its percent stands without a name.
    expect(report.windows.map((window) => window.shortLabel)).toEqual(["", "wk", "mo"]);
    // The current upstream endpoint returns windows only; do not invent balances.
    expect(report.balances).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(content);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("omits default discovery when auth.json lacks an OpenCode Go API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-usage-"));
  const path = join(directory, "auth.json");
  try {
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "other-token" } }));
    expect(await discover(stores(path))).toEqual([]);
    await expect(
      fetchUsage({ store: "file", path }, async () => {
        throw new Error("must not fetch");
      }),
    ).rejects.toThrow("login store no longer exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.each([401, 403])("maps HTTP %i to unavailable", async (status) => {
  const report = await fetchUsage(
    { store: "file", path: fixturePath },
    async () => new Response(null, { status }),
  );
  expect(report).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status, refreshedBy: "opencode" },
  });
});

test.each(["missing file", "unrelated file"])("discovers no accounts for %s", async (scenario) => {
  const path = join(fixtureDirectory, "missing.json");
  if (scenario === "unrelated file") await writeFile(path, "{}");
  expect(await discover(stores(path))).toEqual([]);
});
