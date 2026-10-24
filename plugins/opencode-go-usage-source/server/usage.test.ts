import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { discover, fetchUsage } from "./usage.js";

import { inputSchema } from "../shared/input.js";

// node:sqlite has no @types/node@20 typings; require it with a narrow local type.
const testRequire = createRequire(import.meta.url);
interface TestSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): { run(...params: unknown[]): void };
  close(): void;
}

function writeOpenCodeCredential(
  path: string,
  rows: Array<{ integrationId: string; value: unknown }>,
): void {
  const { DatabaseSync } = testRequire("node:sqlite") as {
    DatabaseSync: new (path: string) => TestSqliteDb;
  };
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE credential (id TEXT PRIMARY KEY, integration_id TEXT, label TEXT NOT NULL, value TEXT NOT NULL, connector_id TEXT, method_id TEXT, active INTEGER, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL)",
  );
  const insert = db.prepare(
    "INSERT INTO credential (id, integration_id, label, value, active, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  rows.forEach((row, index) => {
    insert.run(`cred_${index}`, row.integrationId, "Default", JSON.stringify(row.value), 1, 1, 1);
  });
  db.close();
}

function consoleLoginValue(expires: number) {
  return {
    type: "oauth",
    methodID: "device",
    refresh: "rt_fixture",
    access: "st_fixture",
    expires,
    metadata: {
      server: "https://opencode.ai/console",
      accountID: "acc_fixture",
      email: "fixture@example.com",
      orgID: "wrk_fixture",
      orgName: "Default",
    },
  };
}

const consoleStatusResponse = {
  product: "go",
  renewalProduct: "go",
  cancelAtPeriodEnd: false,
  access: {
    startsAt: "2026-09-17T11:20:59.000Z",
    endsAt: "2026-10-17T11:20:59.000Z",
    meters: {
      fiveHour: {
        resetsAt: "2026-10-09T08:16:49.000Z",
        limitMicroCents: "1200000000",
        usedMicroCents: "120000000",
      },
      week: {
        resetsAt: "2026-10-12T00:00:00.000Z",
        limitMicroCents: "3000000000",
        usedMicroCents: "1500000000",
      },
      month: {
        resetsAt: "2026-10-17T11:20:59.000Z",
        limitMicroCents: "6000000000",
        usedMicroCents: "6000000000",
      },
    },
  },
};

async function withCredentialStore(
  rows: Array<{ integrationId: string; value: unknown }>,
  run: (databasePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-console-"));
  const databasePath = join(directory, "opencode.db");
  try {
    writeOpenCodeCredential(databasePath, rows);
    await run(databasePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

let fixtureDirectory: string;
let fixturePath: string;
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

test("discovery input accepts store locators and rejects credentials", () => {
  expect(inputSchema.safeParse({ apiKey: "unused" }).success).toBe(false);
  expect(() => inputSchema.parse({})).toThrow();
  expect(inputSchema.safeParse({ path: "/tmp/auth.json" }).success).toBe(false);
  expect(inputSchema.safeParse({ store: "other", path: "/tmp/auth.json" }).success).toBe(false);
  expect(inputSchema.safeParse({ store: "api-key", path: "" }).success).toBe(false);
  expect(inputSchema.safeParse({ store: "api-key", path: "/tmp/auth.json" }).success).toBe(true);
  expect(inputSchema.safeParse({ store: "console", path: "/tmp/opencode.db" }).success).toBe(true);
});

const upstreamResponse = {
  usage: {
    rolling: { status: "ok", percent: 21, resetsAt: "2026-09-26T20:00:00.000Z" },
    weekly: { status: "ok", percent: 42, resetsAt: "2026-09-28T00:00:00.000Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-10-01T00:00:00.000Z" },
  },
};

test("discovers and fetches the default key from read-only auth.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-usage-"));
  const path = join(directory, "auth.json");
  const missingDatabase = join(directory, "opencode.db");
  const content = JSON.stringify({ "opencode-go": { type: "api", key: "fixture-key" } });
  try {
    await writeFile(path, content);
    expect(await discover(path, missingDatabase)).toEqual([
      {
        key: expect.stringMatching(/^[a-f0-9]{64}$/),
        harness: "OpenCode",
        input: { store: "api-key", path },
      },
    ]);
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("Authorization"),
      });
      return Response.json(upstreamResponse);
    };
    const report = await fetchUsage({ store: "api-key", path }, fetchApi as typeof fetch);
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

test("discovers the Console login from the OpenCode credential store", async () => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() + 3_600_000) }],
    async (databasePath) => {
      expect(await discover(join(fixtureDirectory, "missing.json"), databasePath)).toEqual([
        {
          key: "acc_fixture",
          label: "fixture@example.com",
          harness: "OpenCode",
          input: { store: "console", path: databasePath },
        },
      ]);
    },
  );
});

test("discovers both logins when auth.json and the credential store exist", async () => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() + 3_600_000) }],
    async (databasePath) => {
      const accounts = await discover(fixturePath, databasePath);
      expect(accounts.map((account) => account.input)).toEqual([
        { store: "console", path: databasePath },
        { store: "api-key", path: fixturePath },
      ]);
    },
  );
});

test("ignores credential rows that are not the Console OAuth login", async () => {
  await withCredentialStore(
    [
      { integrationId: "openrouter", value: { type: "api", key: "other" } },
      { integrationId: "opencode", value: { type: "api", key: "other" } },
    ],
    async (databasePath) => {
      expect(await discover(join(fixtureDirectory, "missing.json"), databasePath)).toEqual([]);
    },
  );
});

test("fetches Console Go usage and maps the three named periods", async () => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() + 3_600_000) }],
    async (databasePath) => {
      const requests: Array<{ url: string; authorization: string | null }> = [];
      const fetchApi = async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json(consoleStatusResponse);
      };
      const report = await fetchUsage(
        { store: "console", path: databasePath },
        fetchApi as typeof fetch,
      );
      expect(requests).toEqual([
        {
          url: "https://opencode.ai/console/api/go/status",
          authorization: "Bearer st_fixture",
        },
      ]);
      expect(report.status).toBe("available");
      expect(report.planLabel).toBe("Go");
      expect(
        report.windows.map((window) => [
          window.id,
          window.usedPct,
          window.resetsAt,
          window.shortLabel,
        ]),
      ).toEqual([
        ["five_hour", 10, "2026-10-09T08:16:49.000Z", "5h"],
        ["weekly", 50, "2026-10-12T00:00:00.000Z", "wk"],
        ["monthly", 100, "2026-10-17T11:20:59.000Z", "mo"],
      ]);
      expect(report.windows.map((window) => window.tone)).toEqual(["ok", "ok", "danger"]);
      // The Console endpoint reports microcent budgets, not balances.
      expect(report.balances).toBeUndefined();
    },
  );
});

test("labels the Go Plus plan", async () => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() + 3_600_000) }],
    async (databasePath) => {
      const report = await fetchUsage({ store: "console", path: databasePath }, (async () =>
        Response.json({ ...consoleStatusResponse, product: "go-plus" })) as typeof fetch);
      expect(report.status).toBe("available");
      expect(report.planLabel).toBe("Go Plus");
    },
  );
});

test("reports an expired Console login with the refreshing CLI", async () => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() - 1_000) }],
    async (databasePath) => {
      const report = await fetchUsage({ store: "console", path: databasePath }, async () => {
        throw new Error("must not fetch");
      });
      expect(report).toEqual({
        status: "unavailable",
        problem: {
          kind: "expired",
          expiresAt: expect.any(String),
          refreshedBy: "opencode",
        },
      });
    },
  );
});

test("reports no quota when the account has no Go subscription", async () => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() + 3_600_000) }],
    async (databasePath) => {
      const report = await fetchUsage({ store: "console", path: databasePath }, (async () =>
        Response.json({ product: null, access: null })) as typeof fetch);
      expect(report).toEqual({
        status: "unavailable",
        problem: {
          kind: "no_quota",
          detail: "This account has no active OpenCode Go subscription.",
        },
      });
    },
  );
});

test.each([401, 403])("maps Console HTTP %i to unavailable", async (status) => {
  await withCredentialStore(
    [{ integrationId: "opencode", value: consoleLoginValue(Date.now() + 3_600_000) }],
    async (databasePath) => {
      const report = await fetchUsage(
        { store: "console", path: databasePath },
        (async () => new Response(null, { status })) as typeof fetch,
      );
      expect(report).toEqual({
        status: "unavailable",
        problem: { kind: "rejected", status, refreshedBy: "opencode" },
      });
    },
  );
});

test("omits default discovery when auth.json lacks an OpenCode Go API key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paseo-go-usage-"));
  const path = join(directory, "auth.json");
  try {
    await writeFile(path, JSON.stringify({ openai: { type: "oauth", access: "other-token" } }));
    expect(await discover(path, join(directory, "missing.db"))).toEqual([]);
    await expect(
      fetchUsage({ store: "api-key", path }, async () => {
        throw new Error("must not fetch");
      }),
    ).rejects.toThrow("login store no longer exists");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("throws when the Console store disappears after discovery", async () => {
  await expect(
    fetchUsage({ store: "console", path: join(fixtureDirectory, "missing.db") }, async () => {
      throw new Error("must not fetch");
    }),
  ).rejects.toThrow("login store no longer exists");
});

test.each([401, 403])("maps HTTP %i to unavailable", async (status) => {
  const report = await fetchUsage(
    { store: "api-key", path: fixturePath },
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
  expect(await discover(path, join(fixtureDirectory, "missing.db"))).toEqual([]);
});
