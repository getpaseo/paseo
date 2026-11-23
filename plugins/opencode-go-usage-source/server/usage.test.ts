import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER, time_created INTEGER DEFAULT 0)",
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

const CONSOLE_STATUS_URL = "https://opencode.ai/console/api/go/status";
const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
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
  const insert = db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  );
  insert.run("inactive", "opencode-go", JSON.stringify({ type: "key", key: "inactive-key" }), 0, 3);
  insert.run("active", "opencode-go", JSON.stringify({ type: "key", key: "active-key" }), 1, 1);
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
  db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run("go", "opencode-go", JSON.stringify({ type: "key", key: "database-key" }), 1, 1);
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
  const insert = db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  );
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
  [null, false],
  [null, true],
  [0, false],
  [0, true],
])("discovers a selected Go key with active=%s and legacy file=%s", async (active, legacy) => {
  const db = await database();
  db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run("migrated", "opencode-go", JSON.stringify({ type: "key", key: "migrated-key" }), active, 1);
  db.close();
  if (!legacy) await rm(fixturePath);
  const accounts = await discover(stores(fixturePath));
  expect(accounts).toEqual([
    {
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: { store: "database", path: join(fixtureDirectory, "opencode.db") },
    },
  ]);
  const report = await fetchUsage(inputSchema.parse(accounts[0]!.input), async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer migrated-key");
    return Response.json(upstreamResponse);
  });
  expect(report.status).toBe("available");
});

test("selects the newest created Go key when no explicit active key exists", async () => {
  const db = await database();
  const insert = db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insert.run("older", "opencode-go", JSON.stringify({ type: "key", key: "older-key" }), null, 1, 9);
  insert.run("newer-a", "opencode-go", JSON.stringify({ type: "key", key: "tie-key" }), null, 2, 8);
  insert.run(
    "newer-b",
    "opencode-go",
    JSON.stringify({ type: "key", key: "selected-key" }),
    null,
    2,
    1,
  );
  db.close();
  const accounts = await discover(stores(fixturePath));
  expect(accounts).toHaveLength(1);
  await fetchUsage(inputSchema.parse(accounts[0]!.input), async (_url, init) => {
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer selected-key");
    return Response.json(upstreamResponse);
  });
});

test.each([
  ["unrelated provider", "anthropic", 1, JSON.stringify({ type: "key", key: "other-key" })],
  [
    "Console sign-in on another server",
    "opencode",
    1,
    JSON.stringify({
      type: "oauth",
      access: "staging-token",
      expires: 0,
      metadata: { server: "https://staging.example.com/console", orgID: "org_TEST" },
    }),
  ],
  [
    "Console key on another server",
    "opencode",
    1,
    JSON.stringify({
      type: "key",
      key: "staging-key",
      metadata: { server: "https://staging.example.com/console" },
    }),
  ],
  ["Console OAuth", "opencode-go", 1, JSON.stringify({ type: "oauth", access: "oauth-token" })],
  ["malformed credential", "opencode-go", 1, "invalid JSON"],
  ["empty key", "opencode-go", 1, JSON.stringify({ type: "key", key: "" })],
])(
  "does not revive a legacy key for a v2 store with %s",
  async (_name, provider, active, value) => {
    const db = await database();
    db.prepare(
      "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
    ).run("credential", provider, value, active, 1);
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

test("discovers a relative OPENCODE_DB under the OpenCode data directory", async () => {
  const paths = defaultStorePaths({
    XDG_DATA_HOME: fixtureDirectory,
    OPENCODE_DB: "go.db",
  });
  const databasePath = join(fixtureDirectory, "opencode", "go.db");
  await mkdir(dirname(databasePath));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, value TEXT, active INTEGER, time_updated INTEGER, time_created INTEGER DEFAULT 0)",
  );
  db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run("go", "opencode-go", JSON.stringify({ type: "key", key: "relative-key" }), 1, 1);
  db.close();
  expect(await discover(paths)).toEqual([
    {
      key: expect.stringMatching(/^[a-f0-9]{64}$/),
      input: { store: "database", path: databasePath },
    },
  ]);
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
      { url: CONSOLE_STATUS_URL, authorization: "Bearer fixture-key" },
      { url: USAGE_URL, authorization: "Bearer fixture-key" },
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

test("keeps the account identity when OpenCode v2 imports the legacy Go login", async () => {
  const paths = stores(fixturePath);
  const [legacy] = await discover(paths);
  const db = await database();
  db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run("imported", "opencode-go", JSON.stringify({ type: "key", key: "fixture-secret" }), null, 1);
  db.close();
  const [migrated] = await discover(paths);
  expect(migrated!.input).toEqual({ store: "database", path: paths.database });
  // Usage settings are saved per account, so the card keeps its visibility and position.
  expect(migrated!.key).toBe(legacy!.key);
});

const consoleSignIn = (overrides: { expires?: number; server?: string } = {}) =>
  JSON.stringify({
    type: "oauth",
    methodID: "device",
    access: "console-token",
    refresh: "console-refresh",
    expires: overrides.expires ?? Date.now() + 3_600_000,
    metadata: {
      ...(overrides.server ? { server: overrides.server } : {}),
      orgID: "org_TESTORG123",
      orgName: "Team",
    },
  });
const goStatus = (
  access: unknown = {
    meters: {
      fiveHour: {
        resetsAt: "2026-08-12T12:00:00.000Z",
        limitMicroCents: "1000000000",
        usedMicroCents: "250000000",
      },
      week: {
        resetsAt: "2026-08-19T12:00:00.000Z",
        limitMicroCents: "2000000000",
        usedMicroCents: "800000000",
      },
      month: {
        resetsAt: "2026-09-01T00:00:00.000Z",
        limitMicroCents: "6000000000",
        usedMicroCents: "3000000000",
      },
    },
  },
) => ({ product: "go", access });

interface Request {
  url: string;
  authorization: string | null;
  orgID: string | null;
  redirect?: RequestRedirect;
}
/** Answers each URL and bearer token pair, recording what was asked. */
function upstream(answers: Record<string, () => Response>) {
  const requests: Request[] = [];
  const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization");
    requests.push({
      url: String(url),
      authorization,
      orgID: headers.get("x-org-id"),
      ...(init?.redirect ? { redirect: init.redirect } : {}),
    });
    const answer = answers[`${String(url)} ${authorization}`];
    return answer ? answer() : new Response(null, { status: 401 });
  };
  return { requests, fetchApi: fetchApi as typeof fetch };
}
async function storeWith(rows: Array<[string, string]>) {
  const db = await database();
  const insert = db.prepare(
    "INSERT INTO credential (id, integration_id, value, active, time_updated) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [integration, value] of rows) insert.run(integration, integration, value, 1, 1);
  db.close();
  await rm(fixturePath);
  const [account] = await discover(stores(fixturePath));
  return inputSchema.parse(account!.input);
}

test("reads Go from the Console sign-in OpenCode serves it with, ahead of the opencode-go key", async () => {
  const input = await storeWith([
    ["opencode", consoleSignIn()],
    ["opencode-go", JSON.stringify({ type: "key", key: "go-key" })],
  ]);
  const { requests, fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus()),
  });
  const report = await fetchUsage(input, fetchApi);
  expect(requests).toEqual([
    {
      url: CONSOLE_STATUS_URL,
      authorization: "Bearer console-token",
      orgID: "org_TESTORG123",
      redirect: "error",
    },
  ]);
  expect(report.status === "available" && report.windows.map((w) => [w.id, w.usedPct])).toEqual([
    ["rolling", 25],
    ["weekly", 40],
    ["monthly", 50],
  ]);
});

test("discovers a Console sign-in on its own, including one saved for the retired host", async () => {
  const input = await storeWith([
    ["opencode", consoleSignIn({ server: "https://console.opencode.ai" })],
  ]);
  const { fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus()),
  });
  expect((await fetchUsage(input, fetchApi)).status).toBe("available");
});

test.each([
  ["another product", { product: "zen", access: null }],
  ["an ended subscription", goStatus(null)],
])("falls back to the opencode-go key when the sign-in's workspace has %s", async (_, body) => {
  const input = await storeWith([
    ["opencode", consoleSignIn()],
    ["opencode-go", JSON.stringify({ type: "key", key: "go-key" })],
  ]);
  const { fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(body),
    [`${USAGE_URL} Bearer go-key`]: () => Response.json(upstreamResponse),
  });
  const report = await fetchUsage(input, fetchApi);
  expect(report.status === "available" && report.windows.map((w) => w.usedPct)).toEqual([
    21, 42, 100,
  ]);
});

test("reports the absent subscription for a Console sign-in without Go", async () => {
  const input = await storeWith([["opencode", consoleSignIn()]]);
  const { fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => Response.json(goStatus(null)),
  });
  expect(await fetchUsage(input, fetchApi)).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No active OpenCode Go subscription" },
  });
});

test("reports an expired sign-in without a request, and keeps it over a rejected fallback key", async () => {
  const expires = Date.now() - 1000;
  const alone = await storeWith([["opencode", consoleSignIn({ expires })]]);
  const { requests, fetchApi } = upstream({});
  const expired = {
    status: "unavailable",
    problem: {
      kind: "expired",
      expiresAt: new Date(expires).toISOString(),
      refreshedBy: "opencode",
    },
  };
  expect(await fetchUsage(alone, fetchApi)).toEqual(expired);
  expect(requests).toEqual([]);
  await rm(join(fixtureDirectory, "opencode.db"));
  await writeFile(fixturePath, "{}");
  const withKey = await storeWith([
    ["opencode", consoleSignIn({ expires })],
    ["opencode-go", JSON.stringify({ type: "key", key: "expired-go-key" })],
  ]);
  expect(await fetchUsage(withKey, fetchApi)).toEqual(expired);
});

test("reads Go with a key on the opencode integration and falls back when its workspace lacks Go", async () => {
  const input = await storeWith([
    ["opencode", JSON.stringify({ type: "key", key: "workspace-key" })],
    ["opencode-go", JSON.stringify({ type: "key", key: "go-key" })],
  ]);
  const served = upstream({
    [`${CONSOLE_STATUS_URL} Bearer workspace-key`]: () => Response.json(goStatus()),
  });
  const report = await fetchUsage(input, served.fetchApi);
  expect(report.status).toBe("available");
  expect(served.requests.map((request) => [request.authorization, request.orgID])).toEqual([
    ["Bearer workspace-key", null],
  ]);
  const refused = upstream({
    [`${USAGE_URL} Bearer workspace-key`]: () => new Response(null, { status: 403 }),
    [`${USAGE_URL} Bearer go-key`]: () => Response.json(upstreamResponse),
  });
  expect((await fetchUsage(input, refused.fetchApi)).status).toBe("available");
  expect(refused.requests.at(-1)).toMatchObject({ url: USAGE_URL, authorization: "Bearer go-key" });
});

test("reports a key on the opencode integration without Go as the absent subscription", async () => {
  const input = await storeWith([["opencode", JSON.stringify({ type: "key", key: "zen-key" })]]);
  const { fetchApi } = upstream({
    [`${USAGE_URL} Bearer zen-key`]: () => new Response(null, { status: 403 }),
  });
  expect(await fetchUsage(input, fetchApi)).toEqual({
    status: "unavailable",
    problem: { kind: "no_quota", detail: "No active OpenCode Go subscription" },
  });
});

test("keeps the card on the opencode key through a temporary failure", async () => {
  const input = await storeWith([
    ["opencode", JSON.stringify({ type: "key", key: "workspace-key" })],
    ["opencode-go", JSON.stringify({ type: "key", key: "go-key" })],
  ]);
  const { requests, fetchApi } = upstream({
    [`${USAGE_URL} Bearer workspace-key`]: () => new Response(null, { status: 503 }),
  });
  await expect(fetchUsage(input, fetchApi)).rejects.toThrow("returned 503");
  expect(requests.some((request) => request.authorization === "Bearer go-key")).toBe(false);
});

test("keeps the card on the Console sign-in through a temporary failure", async () => {
  const input = await storeWith([
    ["opencode", consoleSignIn()],
    ["opencode-go", JSON.stringify({ type: "key", key: "go-key" })],
  ]);
  const { requests, fetchApi } = upstream({
    [`${CONSOLE_STATUS_URL} Bearer console-token`]: () => new Response(null, { status: 503 }),
    [`${USAGE_URL} Bearer go-key`]: () => Response.json(upstreamResponse),
  });
  await expect(fetchUsage(input, fetchApi)).rejects.toThrow("returned 503");
  expect(requests.some((request) => request.authorization === "Bearer go-key")).toBe(false);
});

test("reads a key's usage within the refresh deadline when the Console does not answer", async () => {
  const fetchApi = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === USAGE_URL) return Response.json(upstreamResponse);
    // The Console holds the request open until the caller gives up on it.
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const started = Date.now();
  const report = await fetchUsage({ store: "file", path: fixturePath }, fetchApi);
  expect(report.status).toBe("available");
  // The daemon gives a usage refresh 20 seconds, and the usage API keeps 15 of them.
  expect(Date.now() - started).toBeLessThan(5_000);
}, 20_000);
