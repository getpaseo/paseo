import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

function writeGrokAuth(home: string, auth: Record<string, unknown>): void {
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify(auth));
}

function mockFetch(handlers: Map<string, () => Response>): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL) => {
    const key = url.toString();
    const handler = handlers.get(key);
    if (!handler) throw new Error(`Unmocked fetch: ${key}`);
    return handler();
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("grok usage source", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    for (const key of [
      "APPDATA",
      "COPILOT_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "CURSOR_ACCESS_TOKEN",
      "CURSOR_TOKEN",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "GROK_API_KEY",
      "GROK_TOKEN",
      "KIMI_TOKEN",
      "KIMI_API_KEY",
      "KIMI_CODE_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
    ])
      delete process.env[key];
    fetchApi = mockFetch(new Map());
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });
  function service(
    _options: {
      platform?: typeof process.platform;
      keychain?: () => Promise<unknown | null>;
      cursorHomeDir?: string;
      kimiHomeDir?: string;
    } = {},
  ) {
    return {
      listUsage: async () => {
        const report = await fetchFirst((url, init) => fetchApi(url, init));
        return {
          providers: [
            {
              providerId: "grok",
              ...report,
              error: report.status === "error" ? report.error : null,
              planLabel: report.status === "available" ? (report.planLabel ?? null) : null,
            },
          ],
        };
      },
    };
  }
  function findProvider(
    result: { providers: Array<{ providerId: string } & UsageReport> },
    id: string,
  ) {
    const report = result.providers.find((item) => item.providerId === id);
    if (!report) throw new Error(`Missing usage source ${id}`);
    return report;
  }
  it("fetches Grok usage and preserves zero values", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: { monthlyLimit: { val: 0 }, used: { val: 0 } },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 0,
          remaining: 0,
          limit: 0,
        }),
      ],
    });
  });

  it("fetches Grok usage from live billing shape (config.used.val)", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: {
                monthlyLimit: { val: 150000 },
                used: { val: 37886 },
                billingPeriodStart: "2026-07-01T00:00:00+00:00",
                billingPeriodEnd: "2026-08-01T00:00:00+00:00",
              },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 37886,
          remaining: 112114,
          limit: 150000,
          unit: "credits",
        }),
      ],
    });
  });

  it("fetches Grok usage with nested ~/.grok/auth.json key token", async () => {
    writeGrokAuth(homeDir, {
      "https://auth.x.ai::test-user-id": {
        key: "nested_jwt_token",
        refresh_token: "rt_nested",
        expires_at: "2026-08-01T00:00:00Z",
        user_id: "test-user-id",
        email: "user@example.com",
      },
    });

    let authorization: string | null = null;
    fetchApi = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        config: {
          monthlyLimit: { val: 100 },
          used: { val: 25 },
        },
      });
    }) as typeof fetch;

    const grok = findProvider(await service().listUsage(), "grok");

    expect(authorization).toBe("Bearer nested_jwt_token");
    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 25,
          remaining: 75,
          limit: 100,
        }),
      ],
    });
  });

  it("still accepts legacy Grok usage.creditUsage when config.used is absent", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: { monthlyLimit: { val: 50 } },
              usage: { creditUsage: 10 },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "monthly_credits",
          used: 10,
          remaining: 40,
          limit: 50,
        }),
      ],
    });
  });

  it("fetches Grok unified-billing usage as a weekly window", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
          () =>
            jsonResponse({
              config: {
                currentPeriod: {
                  type: "USAGE_PERIOD_TYPE_WEEKLY",
                  start: "2026-08-24T09:41:40.001370+00:00",
                  end: "2026-08-31T09:41:40.001370+00:00",
                },
                creditUsagePercent: 76.0,
                isUnifiedBillingUser: true,
                billingPeriodStart: "2026-08-24T09:41:40.001370+00:00",
                billingPeriodEnd: "2026-08-31T09:41:40.001370+00:00",
              },
            }),
        ],
      ]),
    );

    const grok = findProvider(await service().listUsage(), "grok");

    expect(grok).toMatchObject({
      status: "available",
      windows: [
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 76,
          remainingPct: 24,
          resetsAt: "2026-08-31T09:41:40.001370+00:00",
          tone: "warning",
        },
      ],
      balances: [],
    });
  });
});

it("discovery returns a locator when fetch finds grok credentials", async () => {
  const previous = process.env["GROK_TOKEN"];
  try {
    process.env["GROK_TOKEN"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover()).toEqual([
      { key: "default", input: { store: "env", locator: "GROK_TOKEN" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env["GROK_TOKEN"];
    else process.env["GROK_TOKEN"] = previous;
  }
});

describe("account discovery", () => {
  it.each(["empty home", "unrelated files"])("returns no accounts for %s", async (scenario) => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const directory = await mkdtemp(join(tmpdir(), "usage-empty-"));
    const original = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      process.env.HOME = directory;
      process.env.USERPROFILE = directory;
      if (scenario === "unrelated files") await writeFile(join(directory, "unrelated.json"), "{}");
      expect(await discover()).toEqual([]);
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, original);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function fetchFirst(fetchApi: typeof fetch) {
  const accounts = await discover();
  const account = accounts[0];
  if (!account) throw new Error("No configured account");
  return fetchUsage(account.input as Parameters<typeof fetchUsage>[0], fetchApi);
}

it.each([401, 403])("reports an existing login rejected with HTTP %i", async (status) => {
  const previous = process.env["GROK_TOKEN"];
  try {
    process.env["GROK_TOKEN"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "GROK_TOKEN" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["GROK_TOKEN"];
    else process.env["GROK_TOKEN"] = previous;
  }
});

it.each([undefined, "USAGE_PERIOD_TYPE_DAILY", "USAGE_PERIOD_TYPE_UNKNOWN_WEEKLY"])(
  "does not invent a monthly period for %s",
  async (type) => {
    const directory = mkdtempSync(join(tmpdir(), "grok-period-"));
    try {
      const locator = join(directory, "auth.json");
      writeFileSync(locator, JSON.stringify({ access_token: "fixture" }));
      const report = await fetchUsage({ store: "file", locator }, async () =>
        Response.json({ config: { creditUsagePercent: 11, currentPeriod: { type } } }),
      );
      expect(report).toMatchObject({
        status: "available",
        windows: [
          {
            id: type ? `period:${type}` : "period:unknown",
            label: type ?? "Current period",
            shortLabel: "",
          },
        ],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("does not call credits monthly when no monthly limit was reported", async () => {
  const directory = mkdtempSync(join(tmpdir(), "grok-credits-"));
  try {
    const locator = join(directory, "auth.json");
    writeFileSync(locator, JSON.stringify({ access_token: "fixture" }));
    const report = await fetchUsage({ store: "file", locator }, async () =>
      Response.json({ config: { used: { val: 11 } } }),
    );
    expect(report).toMatchObject({
      status: "available",
      balances: [{ id: "credits", label: "Credits", used: 11 }],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
