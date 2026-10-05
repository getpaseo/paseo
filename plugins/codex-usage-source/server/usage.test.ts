import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { fetchUsage, discover } from "./usage.js";

import { inputSchema, type CodexUsageInput } from "../shared/input.js";

function authInput(directory: string): CodexUsageInput {
  return { route: { store: "codex", path: join(directory, "auth.json") } };
}

let fixtureHome: string;
beforeEach(async () => {
  fixtureHome = await mkdtemp(join(tmpdir(), "usage-codex-default-"));
  process.env["CODEX_HOME"] = fixtureHome;
  await writeAuth("fixture-supplied");
});

async function writeAuth(accessToken: string, accountId?: string) {
  await writeFile(
    join(fixtureHome, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, account_id: accountId } }),
  );
}

const originalHome = process.env["CODEX_HOME"];
afterEach(async () => {
  await rm(fixtureHome, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env["CODEX_HOME"];
  else process.env["CODEX_HOME"] = originalHome;
});

function response(headers: HeadersInit, accountId?: string): Promise<Response> {
  const request = new Headers(headers);
  expect(request.get("Authorization")).toMatch(/^Bearer fixture-/);
  expect(request.get("ChatGPT-Account-Id")).toBe(accountId ?? null);
  return Promise.resolve(
    new Response(
      JSON.stringify({
        plan_type: "plus",
        rate_limit: {
          primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1700000000 },
        },
      }),
      { status: 200 },
    ),
  );
}

test("explicit route reads Codex auth and preserves the usage request", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    process.env["CODEX_HOME"] = home;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { access_token: "fixture-default", account_id: "account-default" },
      }),
    );
    const report = await fetchUsage(authInput(home), (_url, init) =>
      response(init?.headers ?? {}, "account-default"),
    );
    expect(report).toMatchObject({
      status: "available",
      planLabel: "plus",
      windows: [{ id: "five_hour", usedPct: 30 }],
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discovery input requires a route and rejects raw credentials", () => {
  for (const input of [
    { codexHome: "/unused" },
    { accessToken: "unused" },
    { accessToken: "unused", accountId: "unused" },
  ]) {
    expect(inputSchema.safeParse(input).success).toBe(false);
  }
  expect(() => inputSchema.parse({})).toThrow();
});

test("discovery returns a key when fetch finds Codex token credentials", async () => {
  await writeAuth("fixture-supplied", "account-supplied");
  await fetchUsage(authInput(fixtureHome), (_url, init) =>
    response(init?.headers ?? {}, "account-supplied"),
  );
  expect(await accountFor(authInput(fixtureHome))).toEqual({ key: "account-supplied" });
});

test("coerces credit balance and marks a 96 percent window dangerous", async () => {
  const report = await fetchUsage(
    authInput(fixtureHome),
    async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 96, limit_window_seconds: 604800 },
          },
          credits: { balance: "0" },
        }),
        { status: 200 },
      ),
  );
  expect(report.windows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "five_hour", tone: "ok" }),
      expect.objectContaining({ id: "weekly", tone: "danger" }),
    ]),
  );
  expect(report.balances).toEqual([
    expect.objectContaining({ remaining: 0, unit: "credits", tone: "danger" }),
  ]);
});

test("summarizes the session and weekly windows by default, not code review", async () => {
  const report = await fetchUsage(
    authInput(fixtureHome),
    async () =>
      new Response(
        JSON.stringify({
          rate_limit: {
            primary_window: { used_percent: 12, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 40, limit_window_seconds: 604800 },
          },
          code_review_rate_limit: { primary_window: { used_percent: 5 } },
        }),
        { status: 200 },
      ),
  );
  expect(report.windows.map((window) => [window.id, window.summary ?? false])).toEqual([
    ["five_hour", true],
    ["weekly", true],
    ["code_review:unknown_primary", false],
  ]);
});

test("HTML usage body is an error", async () => {
  await expect(
    fetchUsage(authInput(fixtureHome), async () => new Response("<html>Login</html>")),
  ).rejects.toThrow("Codex usage API returned HTML");
});

test("401 leaves auth.json byte for byte unchanged and makes no refresh request", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-"));
  try {
    process.env["CODEX_HOME"] = home;
    const authPath = join(home, "auth.json");
    const before = JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: "fixture-id",
        access_token: "fixture-stale",
        refresh_token: "fixture-refresh",
        account_id: "fixture-account",
      },
      last_refresh: "2026-07-04T20:35:00Z",
    });
    await writeFile(authPath, before);
    let calls = 0;
    const report = await fetchUsage(authInput(home), async (url) => {
      expect(String(url)).toBe("https://chatgpt.com/backend-api/wham/usage");
      calls++;
      return new Response(null, { status: 401 });
    });
    expect(report.status).toBe("unavailable");
    expect(calls).toBe(1);
    expect(await readFile(authPath, "utf8")).toBe(before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("auth account claim survives token rotation", async () => {
  const token = (suffix: string) =>
    `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "work-id" }, suffix })).toString("base64url")}.signature`;
  await writeAuth(token("first"));
  expect(await accountFor(authInput(fixtureHome))).toEqual({ key: "work-id" });
  await writeAuth(token("second"));
  expect(await accountFor(authInput(fixtureHome))).toEqual({ key: "work-id" });
  await writeAuth("opaque-token");
  expect(await accountFor(authInput(fixtureHome))).toEqual({
    key: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
});

test("discovery reads an email label from auth id_token when access token has no profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-codex-label-"));
  try {
    process.env["CODEX_HOME"] = home;
    const idToken = `header.${Buffer.from(JSON.stringify({ email: "id-owner@example.test" })).toString("base64url")}.signature`;
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: { account_id: "account-id", access_token: "opaque-token", id_token: idToken },
      }),
    );
    expect(await accountFor(authInput(home))).toEqual({
      key: "account-id",
      label: "id-owner@example.test",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("discovers a Pi OAuth login independently of the CLI login", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usage-pi-discovery-"));
  try {
    await mkdir(join(directory, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "agent", "auth.json"),
      JSON.stringify({
        "openai-codex": { type: "oauth", access: "fixture-pi", accountId: "pi-account" },
      }),
    );
    const inputs = await discover(
      { kind: "global" },
      { home: directory, env: {}, platform: "linux" },
    );
    expect(inputs.map((account) => account.input)).toContainEqual({
      route: { store: "pi", path: join(directory, ".pi", "agent", "auth.json") },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function accountFor(input: CodexUsageInput) {
  const accounts = await discover(
    { kind: "global" },
    {
      home: fixtureHome,
      env: {
        CODEX_HOME:
          input.route.store === "codex"
            ? (await import("node:path")).dirname(input.route.path)
            : fixtureHome,
      },
      platform: "linux",
    },
  );
  const account = accounts.find(
    (candidate) => JSON.stringify(candidate.input) === JSON.stringify(input),
  );
  if (!account) throw new Error("Expected discovered login");
  return { key: account.key, ...(account.label ? { label: account.label } : {}) };
}

test.each(["empty home", "unrelated files"])(
  "discovers no Codex accounts in %s",
  async (scenario) => {
    const home = await mkdtemp(join(tmpdir(), "codex-no-login-"));
    try {
      if (scenario === "unrelated files") await writeFile(join(home, "unrelated.json"), "{}");
      expect(await discover({ kind: "global" }, { home, env: {}, platform: "linux" })).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

test.each([401, 403])("reports a Codex login rejected with HTTP %i", async (status) => {
  expect(
    await fetchUsage(authInput(fixtureHome), async () => new Response(null, { status })),
  ).toEqual({ status: "unavailable", problem: { kind: "rejected", status, refreshedBy: "codex" } });
});

// Issue #4165: the primary slot contains the only weekly window.
test("names a seven-day-only primary window from its reported duration", async () => {
  const report = await fetchUsage(authInput(fixtureHome), async () =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: 1, limit_window_seconds: 604800 },
        secondary_window: null,
      },
    }),
  );
  expect(report).toMatchObject({
    status: "available",
    windows: [{ id: "weekly", label: "Weekly", shortLabel: "wk", usedPct: 1 }],
  });
});

test("reports every named additional limit with its own duration identity", async () => {
  const report = await fetchUsage(authInput(fixtureHome), async () =>
    Response.json({
      additional_rate_limits: [
        {
          limit_name: "GPT-5.3-Codex-Spark",
          metered_feature: "codex_bengalfox",
          rate_limit: {
            primary_window: { used_percent: 0, limit_window_seconds: 18000 },
            secondary_window: { used_percent: 0, limit_window_seconds: 604800 },
          },
        },
        {
          limit_name: "Another limit",
          metered_feature: "another",
          rate_limit: {
            primary_window: { used_percent: 4, limit_window_seconds: 7200 },
          },
        },
      ],
    }),
  );
  expect(report).toMatchObject({
    status: "available",
    windows: [
      {
        id: "limit:codex_bengalfox:five_hour",
        label: "GPT-5.3-Codex-Spark · 5-hour",
        shortLabel: "GPT-5.3-Codex-Spark 5h",
      },
      {
        id: "limit:codex_bengalfox:weekly",
        label: "GPT-5.3-Codex-Spark · Weekly",
        shortLabel: "GPT-5.3-Codex-Spark wk",
      },
      { id: "limit:another:7200s", label: "Another limit · 2-hour" },
    ],
  });
});

test("a weekly pin means weekly after the provider moves it between slots", async () => {
  const { resolvePinnedUsage } = await import("../../../packages/app/src/usage/pinned.js");
  const preferences = {
    displayAs: "used" as const,
    serverId: null,
    pins: [{ sourceId: "codex", windowId: "weekly" }],
  };
  for (const primaryWeekly of [false, true]) {
    const weekly = { used_percent: 11, limit_window_seconds: 604800 };
    const report = await fetchUsage(authInput(fixtureHome), async () =>
      Response.json({
        rate_limit: {
          primary_window: primaryWeekly ? weekly : { used_percent: 4, limit_window_seconds: 18000 },
          secondary_window: primaryWeekly ? null : weekly,
        },
      }),
    );
    const entry = {
      id: "codex:account",
      sourceId: "codex",
      sourceLabel: "Codex",
      account: { key: "account" },
      fetchedAt: "2026-10-02T00:00:00Z",
      report,
    };
    expect(resolvePinnedUsage([entry], preferences)).toMatchObject([
      { windows: [{ key: "codex:account/weekly", percentText: "11%", shortLabel: "wk" }] },
    ]);
    // The old slot ID is ambiguous: do not silently retarget a saved Session pin.
    expect(
      resolvePinnedUsage([entry], {
        ...preferences,
        pins: [{ sourceId: "codex", windowId: "session" }],
      }),
    ).toEqual([]);
  }
});

test("unknown lengths and code review never get a duration from their slot", async () => {
  const report = await fetchUsage(authInput(fixtureHome), async () =>
    Response.json({
      rate_limit: {
        primary_window: { used_percent: 11 },
        secondary_window: { used_percent: 22, limit_window_seconds: null },
      },
      code_review_rate_limit: {
        primary_window: { used_percent: 3, limit_window_seconds: 604800 },
        secondary_window: { used_percent: 4, limit_window_seconds: 18000 },
      },
    }),
  );
  expect(report).toMatchObject({
    windows: [
      { id: "unknown_primary", label: "Primary limit", shortLabel: "" },
      { id: "unknown_secondary", label: "Secondary limit", shortLabel: "" },
      { id: "code_review:weekly", label: "Code review · Weekly", shortLabel: "Code review wk" },
      { id: "code_review:five_hour", label: "Code review · 5-hour", shortLabel: "Code review 5h" },
    ],
  });
});

test("session discovery isolates CODEX_HOME and excludes foreign routes", async () => {
  const home = await mkdtemp(join(tmpdir(), "codex-session-scope-"));
  try {
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({ tokens: { access_token: "session-token", account_id: "session-account" } }),
    );
    const scope = {
      kind: "session" as const,
      provider: "codex",
      env: { HOME: home, CODEX_HOME: home },
    };
    const accounts = await discover(scope, { home: "/unused-default-home", env: {} });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.input).toEqual(authInput(home));
    expect(
      await discover({ ...scope, env: { ...scope.env, OPENAI_BASE_URL: "https://other.test" } }),
    ).toEqual([]);
    expect(await discover({ ...scope, provider: "claude" })).toEqual([]);
    expect(
      await discover({ ...scope, env: { HOME: home, CODEX_HOME: join(home, "missing") } }),
    ).toEqual([]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
