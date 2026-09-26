import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "./usage.js";
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
        const report = await fetchUsage({}, (url, init) => fetchApi(url, init));
        return {
          providers: [
            {
              providerId: "grok",
              ...report,
              error: report.error ?? null,
              planLabel: report.planLabel ?? null,
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
