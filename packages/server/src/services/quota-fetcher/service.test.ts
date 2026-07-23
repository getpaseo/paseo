import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderUsage } from "../../server/messages.js";
import type { ProviderUsageFetcher } from "./provider.js";
import { ClaudeQuotaProvider } from "./providers/claude.js";
import { CodexQuotaProvider } from "./providers/codex.js";
import { CopilotQuotaProvider } from "./providers/copilot.js";
import { CursorQuotaProvider } from "./providers/cursor.js";
import { GrokQuotaProvider } from "./providers/grok.js";
import { KimiQuotaProvider } from "./providers/kimi.js";
import { MiniMaxQuotaProvider } from "./providers/minimax.js";
import { ZaiQuotaProvider } from "./providers/zai.js";
import { ProviderUsageService } from "./service.js";

function writeClaudeCredentials(
  dir: string,
  accessToken: string,
  refreshToken = "rt_test",
  subscriptionType = "pro",
  rateLimitTier = "default_1x",
): void {
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: { accessToken, refreshToken, subscriptionType, rateLimitTier },
    }),
  );
}

function writeCodexAuth(dir: string, accessToken: string, refreshToken = "rt_codex"): void {
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, refresh_token: refreshToken } }),
  );
}

function writeKimiCredentials(dir: string, accessToken: string): void {
  mkdirSync(join(dir, "credentials"), { recursive: true });
  writeFileSync(
    join(dir, "credentials", "kimi-code.json"),
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "rt_kimi",
      expires_at: 1_798_812_800,
      scope: "kimi-code",
      token_type: "Bearer",
    }),
  );
}

function writeMiniMaxConfig(dir: string, payload: Record<string, unknown>): void {
  mkdirSync(join(dir, ".mmx"), { recursive: true });
  writeFileSync(join(dir, ".mmx", "config.json"), JSON.stringify(payload));
}

function writeMiniMaxCredentials(
  dir: string,
  accessToken: string,
  expiresAt?: string,
  resourceUrl?: string,
): void {
  mkdirSync(join(dir, ".mmx"), { recursive: true });
  const payload: Record<string, unknown> = { access_token: accessToken };
  if (expiresAt !== undefined) payload["expires_at"] = expiresAt;
  if (resourceUrl !== undefined) payload["resource_url"] = resourceUrl;
  writeFileSync(join(dir, ".mmx", "credentials.json"), JSON.stringify(payload));
}

function makeClaudeResponse(
  overrides: Partial<{
    five_hour: { utilization: number | string; resets_at: string };
    seven_day: { utilization: number | string; resets_at: string };
    seven_day_opus: { utilization: number | string; resets_at: string };
  }> = {},
) {
  return {
    five_hour: { utilization: 11, resets_at: "2026-06-01T21:00:00Z" },
    seven_day: { utilization: 1, resets_at: "2026-06-04T00:00:00Z" },
    seven_day_opus: { utilization: 0.5, resets_at: "2026-06-04T00:00:00Z" },
    ...overrides,
  };
}

function makeCodexResponse(overrides: object = {}) {
  return {
    plan_type: "plus",
    email: "user@example.com",
    rate_limit: {
      primary_window: { used_percent: 42, reset_at: 1_748_812_800 },
      secondary_window: { used_percent: 8, reset_at: 1_749_072_000 },
    },
    ...overrides,
  };
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

function createLogger() {
  const logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger as never;
}

function usageFetcher(usage: ProviderUsage): ProviderUsageFetcher {
  return {
    providerId: usage.providerId,
    displayName: usage.displayName,
    fetchUsage: async () => usage,
  };
}

function findProvider(result: { providers: ProviderUsage[] }, providerId: string): ProviderUsage {
  const provider = result.providers.find((candidate) => candidate.providerId === providerId);
  if (!provider) {
    throw new Error(`Missing provider ${providerId}`);
  }
  return provider;
}

describe("ProviderUsageService", () => {
  it("returns arbitrary registered providers and windows as normalized usage data", async () => {
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        usageFetcher({
          providerId: "glm",
          displayName: "GLM coding plan",
          status: "available",
          planLabel: "GLM coding plan",
          windows: [
            {
              id: "biweekly",
              label: "Biweekly",
              usedPct: 23,
              remainingPct: 77,
              resetsAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        }),
      ],
    });

    await expect(service.listUsage()).resolves.toEqual({
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "glm",
          displayName: "GLM coding plan",
          status: "available",
          planLabel: "GLM coding plan",
          windows: [
            {
              id: "biweekly",
              label: "Biweekly",
              usedPct: 23,
              remainingPct: 77,
              resetsAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        },
      ],
    });
  });

  it("caches usage until forced to refresh", async () => {
    let now = Date.parse("2026-06-19T00:00:00.000Z");
    let calls = 0;
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => now,
      cacheTtlMs: 60_000,
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: async () => {
            calls += 1;
            return {
              providerId: "claude",
              displayName: "Claude",
              status: "available",
              planLabel: "Max 20x",
              windows: [{ id: "session", label: "Session", usedPct: calls }],
            };
          },
        },
      ],
    });

    const first = await service.listUsage();
    now += 30_000;
    const cached = await service.listUsage();
    const refreshed = await service.listUsage({ forceRefresh: true });

    expect(calls).toBe(2);
    expect(cached).toBe(first);
    expect(refreshed.providers[0]?.windows[0]?.usedPct).toBe(2);
  });

  it("deduplicates concurrent cache misses", async () => {
    let calls = 0;
    let resolveUsage: ((usage: ProviderUsage) => void) | null = null;
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: () => {
            calls += 1;
            return new Promise<ProviderUsage>((resolve) => {
              resolveUsage = resolve;
            });
          },
        },
      ],
    });

    const first = service.listUsage();
    const second = service.listUsage();

    expect(calls).toBe(1);
    resolveUsage?.({
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      planLabel: "Max 20x",
      windows: [{ id: "session", label: "Session", usedPct: 12 }],
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(calls).toBe(1);
  });

  it("isolates one provider error without dropping other providers", async () => {
    const service = new ProviderUsageService({
      logger: createLogger(),
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        {
          providerId: "claude",
          displayName: "Claude",
          fetchUsage: async () => {
            throw new Error("Claude auth expired");
          },
        },
        usageFetcher({
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro 20x",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
        }),
      ],
    });

    await expect(service.listUsage()).resolves.toEqual({
      fetchedAt: "2026-06-19T00:00:00.000Z",
      providers: [
        {
          providerId: "claude",
          displayName: "Claude",
          status: "error",
          planLabel: null,
          windows: [],
          balances: [],
          details: [],
          error: "Claude auth expired",
        },
        {
          providerId: "codex",
          displayName: "Codex",
          status: "available",
          planLabel: "Pro 20x",
          windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
        },
      ],
    });
  });
});

describe("real provider usage fetchers", () => {
  let claudeHome: string;
  let codexHome: string;
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "usage-test-claude-"));
    codexHome = mkdtempSync(join(tmpdir(), "usage-test-codex-"));
    homeDir = mkdtempSync(join(tmpdir(), "usage-test-home-"));
    fetchApi = mockFetch(new Map());
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;

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
      "CODEX_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
    ]) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    for (const key in originalEnv) {
      process.env[key] = originalEnv[key];
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  function service(
    options: {
      platform?: typeof process.platform;
      keychain?: () => Promise<unknown | null>;
      kimiHomeDir?: string;
      miniMaxConfigPath?: string;
      miniMaxCredentialsPath?: string;
    } = {},
  ) {
    const logger = createLogger();
    const fetchThroughTestDouble = ((url: RequestInfo | URL, init?: RequestInit) =>
      fetchApi(url, init)) as typeof fetch;
    return new ProviderUsageService({
      logger,
      now: () => Date.parse("2026-06-19T00:00:00.000Z"),
      fetchers: [
        new ClaudeQuotaProvider({
          logger,
          claudeHome,
          claudeKeychainReader: options.keychain ?? (async () => null),
          platform: options.platform,
          fetch: fetchThroughTestDouble,
        }),
        new CodexQuotaProvider({ logger, codexHome, fetch: fetchThroughTestDouble }),
        new CopilotQuotaProvider({ logger, fetch: fetchThroughTestDouble }),
        new CursorQuotaProvider({ logger, fetch: fetchThroughTestDouble }),
        new ZaiQuotaProvider({ logger, fetch: fetchThroughTestDouble }),
        new GrokQuotaProvider({ logger, fetch: fetchThroughTestDouble }),
        new KimiQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          homeDir: options.kimiHomeDir,
        }),
        new MiniMaxQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          configPath: options.miniMaxConfigPath ?? join(homeDir, ".mmx", "config.json"),
          credentialsPath:
            options.miniMaxCredentialsPath ?? join(homeDir, ".mmx", "credentials.json"),
        }),
      ],
      cacheTtlMs: 0,
    });
  }

  it("fetches Claude usage, coerces API numbers, and attaches HTTP timeout signals", async () => {
    writeClaudeCredentials(claudeHome, "at_valid");
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.anthropic.com/api/oauth/usage",
          () =>
            jsonResponse(
              makeClaudeResponse({
                five_hour: { utilization: "11", resets_at: "2026-06-01T21:00:00Z" },
              }),
            ),
        ],
      ]),
    );

    const result = await service().listUsage();
    const claude = findProvider(result, "claude");

    expect(claude).toMatchObject({
      status: "available",
      planLabel: "Pro 1x",
      windows: expect.arrayContaining([
        expect.objectContaining({ id: "five_hour", usedPct: 11 }),
        expect.objectContaining({ id: "weekly", usedPct: 1 }),
        expect.objectContaining({ id: "weekly_opus", usedPct: 0.5 }),
      ]),
    });
    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("accepts a null Claude resets_at when a window has no scheduled reset", async () => {
    writeClaudeCredentials(claudeHome, "at_valid");
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.anthropic.com/api/oauth/usage",
          () =>
            jsonResponse({
              five_hour: { utilization: 0, resets_at: null },
              seven_day: { utilization: 1, resets_at: "2026-06-04T00:00:00Z" },
            }),
        ],
      ]),
    );

    const result = await service().listUsage();
    const claude = findProvider(result, "claude");

    expect(claude).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({ id: "five_hour", usedPct: 0, resetsAt: null }),
        expect.objectContaining({ id: "weekly", usedPct: 1 }),
      ]),
    });
  });

  it("returns unavailable Claude usage when credentials are missing", async () => {
    fetchApi = vi.fn() as never;

    const result = await service().listUsage();
    const claude = findProvider(result, "claude");

    expect(claude.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("refreshes Claude access tokens on 401 and retries", async () => {
    writeClaudeCredentials(claudeHome, "at_expired", "rt_valid");
    let usageCalls = 0;
    fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.anthropic.com/api/oauth/usage") {
        usageCalls += 1;
        if (usageCalls === 1) return new Response(null, { status: 401 });
        return jsonResponse(makeClaudeResponse());
      }
      if (endpoint === "https://platform.claude.com/v1/oauth/token") {
        return jsonResponse({ access_token: "at_refreshed", refresh_token: "rt_new" });
      }
      throw new Error(`Unmocked: ${endpoint}`);
    }) as never;

    const result = await service().listUsage();

    expect(findProvider(result, "claude").status).toBe("available");
    expect(usageCalls).toBe(2);
  });

  it("returns unavailable Claude usage when 401 persists after refresh", async () => {
    writeClaudeCredentials(claudeHome, "at_bad", "rt_bad");
    fetchApi = mockFetch(
      new Map([
        ["https://api.anthropic.com/api/oauth/usage", () => new Response(null, { status: 401 })],
        [
          "https://platform.claude.com/v1/oauth/token",
          () => jsonResponse({ access_token: "at_still_bad", refresh_token: "rt_still_bad" }),
        ],
      ]),
    );

    const result = await service().listUsage();

    expect(findProvider(result, "claude").status).toBe("unavailable");
  });

  it("does not refresh Claude tokens read from the macOS Keychain", async () => {
    const usageFetch = vi.fn(async () => new Response(null, { status: 401 }));
    fetchApi = usageFetch as never;

    const result = await service({
      platform: "darwin",
      keychain: async () => ({
        claudeAiOauth: {
          accessToken: "at_expired",
          refreshToken: "rt_valid",
        },
      }),
    }).listUsage();

    expect(findProvider(result, "claude").status).toBe("unavailable");
    expect(usageFetch).toHaveBeenCalledTimes(1);
    expect(usageFetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer at_expired" }),
      }),
    );
  });

  it("fetches Codex windows and coerces string credit balances", async () => {
    writeCodexAuth(codexHome, "at_codex_valid");
    fetchApi = mockFetch(
      new Map([
        [
          "https://chatgpt.com/backend-api/wham/usage",
          () =>
            jsonResponse(
              makeCodexResponse({
                code_review_rate_limit: null,
                credits: { balance: "0" },
              }),
            ),
        ],
      ]),
    );

    const result = await service().listUsage();
    const codex = findProvider(result, "codex");

    expect(codex).toMatchObject({
      status: "available",
      planLabel: "plus",
      windows: expect.arrayContaining([
        expect.objectContaining({ id: "session", usedPct: 42 }),
        expect.objectContaining({ id: "weekly", usedPct: 8 }),
      ]),
      balances: [expect.objectContaining({ id: "credits", remaining: 0 })],
    });
  });

  it("treats a Codex HTML usage response as auth failure", async () => {
    writeCodexAuth(codexHome, "at_codex_stale");
    fetchApi = mockFetch(
      new Map([
        [
          "https://chatgpt.com/backend-api/wham/usage",
          () => new Response("<html>Login</html>", { status: 200 }),
        ],
        ["https://auth.openai.com/oauth/token", () => new Response(null, { status: 401 })],
      ]),
    );

    const result = await service().listUsage();

    expect(findProvider(result, "codex").status).toBe("unavailable");
  });

  it("persists refreshed Codex tokens to the auth file that was read", async () => {
    const alternateCodexHome = mkdtempSync(join(tmpdir(), "usage-test-codex-alt-"));
    process.env["CODEX_HOME"] = alternateCodexHome;
    writeFileSync(join(alternateCodexHome, "auth.json"), JSON.stringify({ tokens: {} }));
    writeCodexAuth(codexHome, "at_codex_stale", "rt_codex_valid");

    let usageCalls = 0;
    fetchApi = mockFetch(
      new Map([
        [
          "https://chatgpt.com/backend-api/wham/usage",
          () => {
            usageCalls += 1;
            if (usageCalls === 1) return new Response(null, { status: 401 });
            return jsonResponse(makeCodexResponse());
          },
        ],
        [
          "https://auth.openai.com/oauth/token",
          () => jsonResponse({ access_token: "at_codex_fresh", refresh_token: "rt_codex_fresh" }),
        ],
      ]),
    );

    try {
      const result = await service().listUsage();

      const refreshedAuth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
      const untouchedAuth = JSON.parse(readFileSync(join(alternateCodexHome, "auth.json"), "utf8"));
      expect(findProvider(result, "codex").status).toBe("available");
      expect(refreshedAuth.tokens.access_token).toBe("at_codex_fresh");
      expect(refreshedAuth.tokens.refresh_token).toBe("rt_codex_fresh");
      expect(untouchedAuth.tokens.access_token).toBeUndefined();
    } finally {
      rmSync(alternateCodexHome, { recursive: true, force: true });
    }
  });

  it("fetches Copilot usage from COPILOT_TOKEN", async () => {
    process.env["COPILOT_TOKEN"] = "copilot_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.github.com/copilot_internal/user",
          () =>
            jsonResponse({
              copilot_plan: "business",
              quota_reset_date: "2026-07-01T00:00:00Z",
            }),
        ],
      ]),
    );

    const copilot = findProvider(await service().listUsage(), "copilot");

    expect(copilot).toMatchObject({
      status: "available",
      planLabel: "business",
      details: [{ id: "reset", label: "Quota reset", value: "2026-07-01T00:00:00Z" }],
    });
  });

  it("fetches Cursor usage and normalizes malformed billing dates to null", async () => {
    process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
          () =>
            jsonResponse({
              planUsage: {
                totalSpend: "1500",
                includedSpend: "1000",
                bonusSpend: "500",
                remaining: "2500",
                limit: "4000",
              },
              billingCycleStart: "2026-01-14T12:42:14.000Z",
              billingCycleEnd: "not-a-date",
            }),
        ],
      ]),
    );

    const cursor = findProvider(await service().listUsage(), "cursor");

    expect(cursor).toMatchObject({
      status: "available",
      balances: [
        expect.objectContaining({
          id: "plan_usage",
          used: 15,
          remaining: 25,
          limit: 40,
          resetsAt: null,
        }),
      ],
    });
  });

  it("fetches Z.ai usage from ZAI_API_KEY", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.z.ai/api/biz/subscription/list",
          () =>
            jsonResponse({
              data: [
                {
                  productName: "GLM Coding Max",
                  status: "VALID",
                  purchaseTime: "2026-01-12 16:55:13",
                  valid: "2026-02-12 16:55:13-2026-03-12 16:55:13",
                },
              ],
            }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    expect(zai).toMatchObject({
      status: "available",
      planLabel: "GLM Coding Max",
      details: expect.arrayContaining([{ id: "status", label: "Status", value: "VALID" }]),
    });
  });

  it("fetches Grok usage and preserves zero values", async () => {
    process.env["GROK_API_KEY"] = "grok_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://cli-chat-proxy.grok.com/v1/billing",
          () =>
            jsonResponse({
              config: { monthlyLimit: { val: 0 } },
              usage: { creditUsage: 0 },
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

  it("fetches Kimi usage from KIMI_TOKEN", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.kimi.com/coding/v1/usages",
          () =>
            jsonResponse({
              usage: {
                limit: "100",
                remaining: "74",
                resetTime: "2026-02-11T17:32:50Z",
              },
            }),
        ],
      ]),
    );

    const kimi = findProvider(await service().listUsage(), "kimi");

    expect(kimi).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "coding_usage",
          usedPct: 26,
          remainingPct: 74,
          resetsAt: "2026-02-11T17:32:50Z",
        }),
      ],
    });
  });

  it("fetches Kimi usage from the CLI credential home", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "kimi_cli_token");
    let requestedUrl: string | null = null;
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url.toString();
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        usage: {
          limit: "200",
          remaining: "150",
          resetTime: "2026-06-23T05:12:17Z",
        },
      });
    }) as unknown as typeof fetch;

    const kimi = findProvider(await service({ kimiHomeDir: homeDir }).listUsage(), "kimi");

    expect(requestedUrl).toBe("https://api.kimi.com/coding/v1/usages");
    expect(authorization).toBe("Bearer kimi_cli_token");
    expect(kimi).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "coding_usage",
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-06-23T05:12:17Z",
        }),
      ],
    });
  });

  it("fetches MiniMax usage from MINIMAX_API_KEY against the global endpoint", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    let requestedUrl: string | null = null;
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url.toString();
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        model_remains: [
          {
            model_name: "MiniMax-M2.7",
            end_time: Date.parse("2026-06-19T05:00:00.000Z"),
            weekly_end_time: Date.parse("2026-06-26T00:00:00.000Z"),
            current_interval_total_count: 1000,
            current_interval_usage_count: 250,
            current_interval_remaining_percent: 75,
            current_weekly_total_count: 5000,
            current_weekly_usage_count: 1200,
            current_weekly_remaining_percent: 76,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(requestedUrl).toBe("https://api.minimax.io/v1/token_plan/remains");
    expect(authorization).toBe("Bearer minimax_test_token");
    expect(miniMax).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({
          id: "interval_MiniMax-M2.7",
          label: "MiniMax-M2.7 · Interval",
          usedPct: 25,
          remainingPct: 75,
          resetsAt: "2026-06-19T05:00:00.000Z",
        }),
        expect.objectContaining({
          id: "weekly_MiniMax-M2.7",
          label: "MiniMax-M2.7 · Weekly",
          usedPct: 24,
          remainingPct: 76,
          resetsAt: "2026-06-26T00:00:00.000Z",
        }),
      ]),
    });
  });

  it("returns unavailable MiniMax usage when no credentials are configured", async () => {
    fetchApi = vi.fn() as never;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(miniMax.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
  });

  it("reads MiniMax OAuth credentials from the CLI credentials file", async () => {
    writeMiniMaxCredentials(
      homeDir,
      "minimax_oauth_token",
      "2030-01-01T00:00:00.000Z",
      "https://account.example.com",
    );
    let requestedUrl: string | null = null;
    fetchApi = (async (url: RequestInfo | URL) => {
      requestedUrl = url.toString();
      return jsonResponse({ model_remains: [] });
    }) as unknown as typeof fetch;

    await service().listUsage();

    expect(requestedUrl).toBe("https://account.example.com/v1/token_plan/remains");
  });

  it("falls back to MiniMax api_key in the CLI config file", async () => {
    writeMiniMaxConfig(homeDir, {
      api_key: "minimax_config_key",
      region: "cn",
    });
    let requestedUrl: string | null = null;
    fetchApi = (async (url: RequestInfo | URL) => {
      requestedUrl = url.toString();
      return jsonResponse({ model_remains: [] });
    }) as unknown as typeof fetch;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(requestedUrl).toBe("https://api.minimaxi.com/v1/token_plan/remains");
    expect(miniMax.status).toBe("unavailable");
  });

  it("marks exhausted MiniMax interval windows with a danger tone", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.minimax.io/v1/token_plan/remains",
          () =>
            jsonResponse({
              model_remains: [
                {
                  model_name: "MiniMax-M2.7",
                  end_time: Date.parse("2026-06-19T05:00:00.000Z"),
                  weekly_end_time: Date.parse("2026-06-26T00:00:00.000Z"),
                  current_interval_total_count: 100,
                  current_interval_usage_count: 100,
                  current_interval_remaining_percent: 0,
                  current_interval_status: 2,
                  current_weekly_total_count: 100,
                  current_weekly_usage_count: 10,
                  current_weekly_remaining_percent: 90,
                  current_weekly_status: 1,
                },
              ],
            }),
        ],
      ]),
    );

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(miniMax).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({
          id: "interval_MiniMax-M2.7",
          usedPct: 100,
          tone: "danger",
        }),
        expect.objectContaining({
          id: "weekly_MiniMax-M2.7",
          tone: "ok",
        }),
      ]),
    });
  });
});

// Regression for #2320: providers hardcoded `tone: "ok"`, which suppressed the client's
// own thresholds (window-bar.tsx reads `window.tone ?? deriveTone(usedPct)`), so a bar
// stayed green at 99%. Codex escalated to "warning" but could never reach "danger".
describe("usage bars escalate as they fill", () => {
  let claudeHome: string;
  let codexHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "paseo-tone-claude-"));
    codexHome = mkdtempSync(join(tmpdir(), "paseo-tone-codex-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });
  });

  function claudeAt(utilization: number) {
    writeClaudeCredentials(claudeHome, "at_valid");
    return new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      claudeKeychainReader: async () => null,
      fetch: mockFetch(
        new Map([
          [
            "https://api.anthropic.com/api/oauth/usage",
            () =>
              jsonResponse({
                seven_day: { utilization, resets_at: "2026-06-04T00:00:00Z" },
              }),
          ],
        ]),
      ),
    }).fetchUsage();
  }

  it.each([
    [10, "ok"],
    [75, "warning"],
    [99, "danger"],
  ])("a Claude window at %s%% is %s", async (utilization, tone) => {
    const usage = await claudeAt(utilization);
    expect(usage.windows).toEqual([expect.objectContaining({ id: "weekly", tone })]);
  });

  it("a Codex window can reach danger, not just warning", async () => {
    writeCodexAuth(codexHome, "at_codex");
    const usage = await new CodexQuotaProvider({
      logger: createLogger(),
      codexHome,
      fetch: mockFetch(
        new Map([
          [
            "https://chatgpt.com/backend-api/wham/usage",
            () =>
              jsonResponse(
                makeCodexResponse({
                  rate_limit: {
                    primary_window: { used_percent: 12, reset_at: 1_748_812_800 },
                    secondary_window: { used_percent: 96, reset_at: 1_749_072_000 },
                  },
                }),
              ),
          ],
        ]),
      ),
    }).fetchUsage();

    expect(usage.windows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "session", tone: "ok" }),
        expect.objectContaining({ id: "weekly", tone: "danger" }),
      ]),
    );
  });
});
