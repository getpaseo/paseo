import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
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

function writeTeamClaudeServerState(dir: string, port = 3456): void {
  writeFileSync(join(dir, "teamclaude.server.json"), JSON.stringify({ port }));
}

function writeCodexAuth(dir: string, accessToken: string, refreshToken = "rt_codex"): void {
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ tokens: { access_token: accessToken, refresh_token: refreshToken } }),
  );
}

function kimiCredentialPath(dir: string): string {
  return join(dir, "credentials", "kimi-code.json");
}

function writeKimiCredentials(dir: string, accessToken: string, overrides: object = {}): void {
  mkdirSync(join(dir, "credentials"), { recursive: true });
  writeFileSync(
    kimiCredentialPath(dir),
    JSON.stringify({
      access_token: accessToken,
      refresh_token: "rt_kimi",
      expires_at: 1_798_812_800,
      expires_in: 900,
      scope: "kimi-code",
      token_type: "Bearer",
      ...overrides,
    }),
  );
}

function writeGrokAuth(home: string, auth: Record<string, unknown>): void {
  mkdirSync(join(home, ".grok"), { recursive: true });
  writeFileSync(join(home, ".grok", "auth.json"), JSON.stringify(auth));
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
        new GrokQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          // Match Kimi: inject temp HOME so nested auth-file tests work on Windows
          // (os.homedir() uses USERPROFILE there and ignores process.env.HOME).
          homeDir,
        }),
        new KimiQuotaProvider({
          logger,
          fetch: fetchThroughTestDouble,
          // Never leave this undefined: the provider would fall back to os.homedir() and
          // read — and now write — the developer's real Kimi credentials.
          homeDir: options.kimiHomeDir ?? homeDir,
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
        expect.objectContaining({ id: "weekly_model_opus", usedPct: 0.5 }),
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

  it("returns the TeamClaude active account usage without using Claude credentials", async () => {
    writeClaudeCredentials(claudeHome, "at_direct_claude");
    writeTeamClaudeServerState(homeDir);
    const keychain = vi.fn(async () => ({
      claudeAiOauth: { accessToken: "at_keychain_claude" },
    }));
    fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url.toString()).toBe("http://127.0.0.1:3456/teamclaude/status");
      expect(init).toEqual({
        method: "GET",
        signal: expect.any(AbortSignal),
      });
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(new Headers(init?.headers).has("x-api-key")).toBe(false);
      return jsonResponse({
        currentAccount: "active@example.com",
        switchThreshold: 0.98,
        accounts: [
          {
            name: "other@example.com",
            provider: "anthropic",
            quota: { unified5h: 0.1, unified7d: 0.2, modelWeekly: {} },
          },
          {
            name: "active@example.com",
            provider: "anthropic",
            quota: {
              unified5h: 0.98,
              unified7d: 0.41,
              unified5hReset: 1_786_467_000_000,
              unified7dReset: 1_787_014_800_000,
              modelWeekly: {
                "7d_oi": { utilization: 0.6, reset: 1_787_014_800_000 },
              },
            },
          },
        ],
      });
    }) as never;

    const usage = await new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      claudeKeychainReader: keychain,
      platform: "darwin",
      fetch: fetchApi,
      claudeLaunch: {
        command: ["/opt/homebrew/bin/teamcodex", "run", "--"],
        xdgConfigHome: homeDir,
      },
    }).fetchUsage();

    expect(usage).toEqual({
      providerId: "claude",
      displayName: "Claude",
      status: "available",
      planLabel: "active@example.com",
      sourceLabel: "TeamClaude active account",
      windows: [
        {
          id: "five_hour",
          label: "Session",
          usedPct: 98,
          remainingPct: 2,
          resetsAt: "2026-08-11T16:50:00.000Z",
          tone: "danger",
        },
        {
          id: "weekly",
          label: "Weekly",
          usedPct: 41,
          remainingPct: 59,
          resetsAt: "2026-08-18T01:00:00.000Z",
          tone: "ok",
        },
        {
          id: "weekly_model_fable",
          label: "Weekly \u00b7 Fable",
          usedPct: 60,
          remainingPct: 40,
          resetsAt: "2026-08-18T01:00:00.000Z",
          tone: "ok",
        },
      ],
      balances: [],
      details: [],
      error: null,
    });
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(keychain).not.toHaveBeenCalled();
  });

  it("does not fall back to direct Claude usage when configured TeamClaude is unavailable", async () => {
    writeClaudeCredentials(claudeHome, "at_direct_claude");
    const keychain = vi.fn(async () => ({
      claudeAiOauth: { accessToken: "at_keychain_claude" },
    }));
    fetchApi = vi.fn() as never;

    const usage = await new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      claudeKeychainReader: keychain,
      platform: "darwin",
      fetch: fetchApi,
      claudeLaunch: {
        command: ["teamcodex", "run", "--"],
        xdgConfigHome: homeDir,
      },
    }).fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(fetchApi).not.toHaveBeenCalled();
    expect(keychain).not.toHaveBeenCalled();
  });

  it("rejects malformed TeamClaude status without falling back to direct Claude usage", async () => {
    writeClaudeCredentials(claudeHome, "at_direct_claude");
    writeTeamClaudeServerState(homeDir);
    fetchApi = vi.fn(async () =>
      jsonResponse({
        currentAccount: "active@example.com",
        accounts: [
          {
            name: "active@example.com",
            provider: "anthropic",
            quota: { unified5h: "almost full" },
          },
        ],
      }),
    ) as never;

    const usage = await new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
      claudeLaunch: {
        command: ["teamcodex", "run", "--"],
        xdgConfigHome: homeDir,
      },
    }).fetchUsage();

    expect(usage.status).toBe("unavailable");
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).not.toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.anything(),
    );
  });

  it("preserves direct Claude usage when the configured command is not teamcodex run", async () => {
    writeClaudeCredentials(claudeHome, "at_direct_claude");
    fetchApi = mockFetch(
      new Map([
        ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
      ]),
    );

    const usage = await new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      fetch: fetchApi,
      claudeLaunch: {
        command: ["teamcodex", "status"],
        xdgConfigHome: homeDir,
      },
    }).fetchUsage();

    expect(usage.status).toBe("available");
    expect(usage.sourceLabel).toBeUndefined();
    expect(fetchApi).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/usage",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer at_direct_claude" }),
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
          "https://cli-chat-proxy.grok.com/v1/billing",
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
          "https://cli-chat-proxy.grok.com/v1/billing",
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

  it("reads Kimi credentials whose optional fields are null", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "kimi_cli_token", {
      expires_at: null,
      expires_in: null,
      scope: null,
      token_type: null,
    });
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.kimi.com/coding/v1/usages",
          () => jsonResponse({ usage: { limit: "100", remaining: "60" } }),
        ],
      ]),
    );

    const kimi = findProvider(await service({ kimiHomeDir: homeDir }).listUsage(), "kimi");

    expect(kimi.status).toBe("available");
  });

  it("persists refreshed Kimi tokens to the credential file that was read", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_expired", {
      preserved_field: "keep-me",
    });
    const authorization: Array<string | null> = [];
    let usageCalls = 0;
    fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.kimi.com/coding/v1/usages") {
        usageCalls += 1;
        authorization.push(
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? null,
        );
        if (usageCalls === 1) return new Response(null, { status: 401 });
        return jsonResponse({ usage: { limit: "100", remaining: "74" } });
      }
      if (endpoint === "https://auth.kimi.com/api/oauth/token") {
        expect(init?.method).toBe("POST");
        expect(init?.body?.toString()).toContain("grant_type=refresh_token");
        expect(init?.body?.toString()).toContain("refresh_token=rt_kimi");
        return jsonResponse({
          access_token: "at_kimi_fresh",
          refresh_token: "rt_kimi_rotated",
          expires_in: 900,
        });
      }
      throw new Error(`Unmocked fetch: ${endpoint}`);
    }) as never;

    const result = await service({ kimiHomeDir: homeDir }).listUsage();
    const persisted = JSON.parse(
      readFileSync(kimiCredentialPath(join(homeDir, ".kimi-code")), "utf8"),
    );

    expect(findProvider(result, "kimi").status).toBe("available");
    expect(authorization).toEqual(["Bearer at_kimi_expired", "Bearer at_kimi_fresh"]);
    expect(persisted).toMatchObject({
      access_token: "at_kimi_fresh",
      refresh_token: "rt_kimi_rotated",
      expires_in: 900,
      scope: "kimi-code",
      preserved_field: "keep-me",
    });
    expect(persisted.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("prefers a Kimi token rewritten on disk over refreshing again", async () => {
    const kimiHome = join(homeDir, ".kimi-code");
    writeKimiCredentials(kimiHome, "at_kimi_old");
    let usageCalls = 0;
    fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.kimi.com/coding/v1/usages") {
        usageCalls += 1;
        if (usageCalls === 1) {
          writeKimiCredentials(kimiHome, "at_kimi_rewritten");
          return new Response(null, { status: 401 });
        }
        expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
          "Bearer at_kimi_rewritten",
        );
        return jsonResponse({ usage: { limit: "100", remaining: "50" } });
      }
      throw new Error(`Unmocked fetch: ${endpoint}`);
    }) as never;

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("available");
    expect(usageCalls).toBe(2);
  });

  it("keeps Kimi credentials rotated by the CLI during the refresh", async () => {
    const kimiHome = join(homeDir, ".kimi-code");
    writeKimiCredentials(kimiHome, "at_kimi_expired");
    fetchApi = mockFetch(
      new Map([
        ["https://api.kimi.com/coding/v1/usages", () => new Response(null, { status: 401 })],
        [
          "https://auth.kimi.com/api/oauth/token",
          () => {
            writeKimiCredentials(kimiHome, "at_kimi_cli", { refresh_token: "rt_kimi_cli" });
            return jsonResponse({
              access_token: "at_kimi_fresh",
              refresh_token: "rt_kimi_rotated",
              expires_in: 900,
            });
          },
        ],
      ]),
    );

    await service({ kimiHomeDir: homeDir }).listUsage();
    const persisted = JSON.parse(readFileSync(kimiCredentialPath(kimiHome), "utf8"));

    expect(persisted).toMatchObject({
      access_token: "at_kimi_cli",
      refresh_token: "rt_kimi_cli",
    });
  });

  it("discards a refreshed Kimi merge if the CLI rotates credentials after the guard but before the rename", async () => {
    const kimiHome = join(homeDir, ".kimi-code");
    writeKimiCredentials(kimiHome, "at_kimi_expired");
    fetchApi = mockFetch(
      new Map([
        ["https://api.kimi.com/coding/v1/usages", () => new Response(null, { status: 401 })],
        [
          "https://auth.kimi.com/api/oauth/token",
          () =>
            jsonResponse({
              access_token: "at_kimi_fresh",
              refresh_token: "rt_kimi_fresh",
              expires_in: 900,
            }),
        ],
      ]),
    );

    // The credential-file guard runs, passes, and only then does the CLI rotate the file
    // — simulated by mutating the file as a side effect of the temp-file write, which is
    // the async I/O step that sits between the guard read and the final rename.
    const realWriteFile = fsPromises.writeFile;
    const writeFileSpy = vi
      .spyOn(fsPromises, "writeFile")
      .mockImplementationOnce(async (...args: Parameters<typeof fsPromises.writeFile>) => {
        writeKimiCredentials(kimiHome, "at_kimi_cli", { refresh_token: "rt_kimi_cli" });
        return realWriteFile(...args);
      });

    await service({ kimiHomeDir: homeDir }).listUsage();
    const persisted = JSON.parse(readFileSync(kimiCredentialPath(kimiHome), "utf8"));

    expect(persisted).toMatchObject({
      access_token: "at_kimi_cli",
      refresh_token: "rt_kimi_cli",
    });

    writeFileSpy.mockRestore();
  });

  it("does not recreate a Kimi credential file deleted during the refresh", async () => {
    const credentialPath = kimiCredentialPath(join(homeDir, ".kimi-code"));
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_expired");
    fetchApi = mockFetch(
      new Map([
        ["https://api.kimi.com/coding/v1/usages", () => new Response(null, { status: 401 })],
        [
          "https://auth.kimi.com/api/oauth/token",
          () => {
            rmSync(credentialPath, { force: true });
            return jsonResponse({ access_token: "at_kimi_fresh", expires_in: 900 });
          },
        ],
      ]),
    );

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(existsSync(credentialPath)).toBe(false);
  });

  it("returns unavailable Kimi usage when the token refresh is rejected", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_expired");
    fetchApi = mockFetch(
      new Map([
        ["https://api.kimi.com/coding/v1/usages", () => new Response(null, { status: 401 })],
        ["https://auth.kimi.com/api/oauth/token", () => new Response(null, { status: 400 })],
      ]),
    );

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
  });

  it("does not refresh Kimi tokens read from the environment", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const usageFetch = vi.fn(async () => new Response(null, { status: 401 }));
    fetchApi = usageFetch as never;

    const result = await service().listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(usageFetch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh Kimi tokens on a 403", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_forbidden");
    const usageFetch = vi.fn(async () => new Response(null, { status: 403 }));
    fetchApi = usageFetch as never;

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(usageFetch).toHaveBeenCalledTimes(1);
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

// Model- and surface-scoped weekly limits arrive in a `limits[]` array rather than the
// top-level `seven_day_*` keys, which now return null on most accounts.
describe("ClaudeQuotaProvider scoped weekly limits", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "paseo-claude-limits-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  function fableLimit(overrides: Record<string, unknown> = {}) {
    return {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 0,
      severity: "normal",
      resets_at: "2026-06-04T00:00:00Z",
      is_active: false,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      ...overrides,
    };
  }

  function claudeProvider(body: unknown) {
    writeClaudeCredentials(claudeHome, "at_valid");
    const logger = createLogger() as unknown as { warn: ReturnType<typeof vi.fn> };
    const provider = new ClaudeQuotaProvider({
      logger: logger as never,
      claudeHome,
      claudeKeychainReader: async () => null,
      fetch: mockFetch(
        new Map([["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(body)]]),
      ),
    });
    return { provider, logger };
  }

  it("renders a scoped weekly limit as its own window", async () => {
    const { provider } = claudeProvider({
      five_hour: { utilization: 6, resets_at: "2026-06-01T21:00:00Z" },
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [fableLimit()],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toContainEqual(
      expect.objectContaining({ id: "weekly_model_fable", label: "Weekly · Fable" }),
    );
  });

  it("renders a scoped window that is at zero and inactive", async () => {
    const { provider } = claudeProvider({
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [fableLimit({ percent: 0, is_active: false })],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toContainEqual(
      expect.objectContaining({ id: "weekly_model_fable", usedPct: 0, remainingPct: 100 }),
    );
  });

  it("ignores session and all-models entries so they do not duplicate the top-level windows", async () => {
    const { provider } = claudeProvider({
      five_hour: { utilization: 6, resets_at: "2026-06-01T21:00:00Z" },
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [
        { kind: "session", percent: 6, resets_at: "2026-06-01T21:00:00Z", scope: null },
        { kind: "weekly_all", percent: 23, resets_at: "2026-06-04T00:00:00Z", scope: null },
        fableLimit(),
      ],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "weekly",
      "weekly_model_fable",
    ]);
  });

  it("labels a surface-scoped limit from its surface name", async () => {
    const { provider } = claudeProvider({
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [
        fableLimit({ scope: { model: null, surface: { id: "code", display_name: "Code" } } }),
      ],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toContainEqual(
      expect.objectContaining({ id: "weekly_surface_code", label: "Weekly · Code" }),
    );
  });

  it("skips a scoped limit with no resolvable label rather than rendering an unlabelled bar", async () => {
    const { provider, logger } = claudeProvider({
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [fableLimit({ scope: { model: { id: null, display_name: null }, surface: null } })],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(logger.warn).toHaveBeenCalled();
  });

  // Regression: an additive section must never take down data that already parsed.
  it("keeps the top-level windows when a limits entry is malformed", async () => {
    const { provider, logger } = claudeProvider({
      five_hour: { utilization: 6, resets_at: "2026-06-01T21:00:00Z" },
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [{ percent: "not-a-kind" }, fableLimit()],
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("available");
    expect(usage.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "weekly",
      "weekly_model_fable",
    ]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("warns when a successful response describes no windows at all", async () => {
    const { provider, logger } = claudeProvider({ limits: [] });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Claude usage response parsed but produced no windows",
    );
  });
});
/**
 * The reconciliation matrix.
 *
 * Four review rounds on PR #2303 each found a different hole in how the two
 * representations of one scoped limit get combined, because each fix was tested against
 * the case that was reported rather than the space of cases. This walks the space:
 * every combination of which representation carries the limit, whether the `limits[]`
 * entry supplies values, and whether the two descriptions denote the same limit at all.
 */
describe("ClaudeQuotaProvider scoped limit reconciliation", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "paseo-claude-matrix-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  const RESETS = "2026-06-04T00:00:00Z";

  function scoped(scope: unknown, percent: number | null = 30, resetsAt: string | null = RESETS) {
    return { kind: "weekly_scoped", percent, resets_at: resetsAt, scope };
  }

  const model = (name: string | null, id: string | null = null) => ({
    model: { id, display_name: name },
    surface: null,
  });
  const surface = (name: string | null, id: string | null = null) => ({
    model: null,
    surface: { id, display_name: name },
  });

  async function windowsFor(body: Record<string, unknown>) {
    writeClaudeCredentials(claudeHome, "at_valid");
    const usage = await new ClaudeQuotaProvider({
      logger: createLogger(),
      claudeHome,
      claudeKeychainReader: async () => null,
      fetch: mockFetch(
        new Map([["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(body)]]),
      ),
    }).fetchUsage();
    return usage.windows;
  }

  it("which representation carries the limit: legacy only", async () => {
    const windows = await windowsFor({
      seven_day_omelette: { utilization: 12, resets_at: RESETS },
    });
    expect(windows).toEqual([
      expect.objectContaining({
        id: "weekly_model_omelette",
        label: "Weekly · Omelette",
        usedPct: 12,
      }),
    ]);
  });

  it("which representation carries the limit: limits[] only", async () => {
    const windows = await windowsFor({ limits: [scoped(model("Fable"), 2)] });
    expect(windows).toEqual([
      expect.objectContaining({
        id: "weekly_model_fable",
        label: "Weekly · Fable",
        usedPct: 2,
      }),
    ]);
  });

  it("which representation carries the limit: both, same limit — one bar, scoped identity", async () => {
    const windows = await windowsFor({
      seven_day_omelette: { utilization: 12, resets_at: RESETS },
      limits: [scoped(model("Omelette"), 30)],
    });
    expect(windows).toEqual([
      expect.objectContaining({ id: "weekly_model_omelette", usedPct: 30 }),
    ]);
  });

  it("which representation carries the limit: both, different limits — two bars", async () => {
    const windows = await windowsFor({
      seven_day_opus: { utilization: 8, resets_at: RESETS },
      limits: [scoped(model("Fable"), 2)],
    });
    expect(windows.map((w) => w.id)).toEqual(["weekly_model_opus", "weekly_model_fable"]);
  });

  it("which representation carries the limit: neither", async () => {
    const windows = await windowsFor({ seven_day: { utilization: 23, resets_at: RESETS } });
    expect(windows.map((w) => w.id)).toEqual(["weekly"]);
  });

  const legacy = { seven_day_omelette: { utilization: 12, resets_at: RESETS } };

  it("value fallback when the scoped entry is sparse: scoped values win when present", async () => {
    const windows = await windowsFor({
      ...legacy,
      limits: [scoped(model("Omelette"), 30, "2026-06-09T00:00:00Z")],
    });
    expect(windows[0]).toMatchObject({ usedPct: 30, resetsAt: "2026-06-09T00:00:00Z" });
  });

  it("value fallback when the scoped entry is sparse: percentage falls back per field", async () => {
    const windows = await windowsFor({
      ...legacy,
      limits: [scoped(model("Omelette"), null, "2026-06-09T00:00:00Z")],
    });
    expect(windows[0]).toMatchObject({ usedPct: 12, resetsAt: "2026-06-09T00:00:00Z" });
  });

  it("value fallback when the scoped entry is sparse: reset time falls back per field", async () => {
    const windows = await windowsFor({
      ...legacy,
      limits: [scoped(model("Omelette"), 30, null)],
    });
    expect(windows[0]).toMatchObject({ usedPct: 30, resetsAt: RESETS });
  });

  it("value fallback when the scoped entry is sparse: both fall back when the scoped entry only names the limit", async () => {
    const windows = await windowsFor({
      ...legacy,
      limits: [scoped(model("Omelette"), null, null)],
    });
    expect(windows[0]).toMatchObject({ usedPct: 12, resetsAt: RESETS });
  });

  it("value fallback when the scoped entry is sparse: stays empty when neither side has a value", async () => {
    const windows = await windowsFor({ limits: [scoped(model("Fable"), null, null)] });
    expect(windows[0]).toMatchObject({ id: "weekly_model_fable", usedPct: null });
  });

  it("identity: a surface never matches a legacy model window of the same name", async () => {
    const windows = await windowsFor({
      seven_day_omelette: { utilization: 12, resets_at: RESETS },
      limits: [scoped(surface("Omelette"), 30)],
    });
    expect(windows.map((w) => w.id)).toEqual(["weekly_model_omelette", "weekly_surface_omelette"]);
    expect(windows[0]).toMatchObject({ usedPct: 12 });
    expect(windows[1]).toMatchObject({ usedPct: 30 });
  });

  it("identity: a model and a surface of the same name stay apart", async () => {
    const windows = await windowsFor({
      limits: [scoped(model("Code"), 4), scoped(surface("Code"), 9)],
    });
    expect(windows.map((w) => w.id)).toEqual(["weekly_model_code", "weekly_surface_code"]);
  });

  it("identity: ids decide when both sides have one", async () => {
    const windows = await windowsFor({
      limits: [
        scoped(model("Fable-Pro", "fable-pro"), 4),
        scoped(model("Fable_Pro", "fable_pro"), 9),
      ],
    });
    expect(windows.map((w) => w.id)).toEqual(["weekly_model_fable-pro", "weekly_model_fable_pro"]);
  });

  it("identity: names decide when ids are absent, so indistinguishable entries merge", async () => {
    const windows = await windowsFor({
      limits: [scoped(model("Fable Pro"), 4), scoped(model("Fable-Pro"), 9)],
    });
    expect(windows).toEqual([
      expect.objectContaining({ id: "weekly_model_fable_pro", usedPct: 9 }),
    ]);
  });

  it("identity: a renamed scope keeps its id when the API supplies one", async () => {
    const before = await windowsFor({ limits: [scoped(model("Fable", "fable"), 2)] });
    const after = await windowsFor({ limits: [scoped(model("Fable 5", "fable"), 2)] });
    expect(before[0]?.id).toBe("weekly_model_fable");
    expect(after[0]?.id).toBe("weekly_model_fable");
    expect(after[0]?.label).toBe("Weekly · Fable 5");
  });

  it("identity: a limit keeps one id whichever representation carries it", async () => {
    const viaLegacy = await windowsFor({
      seven_day_omelette: { utilization: 12, resets_at: RESETS },
    });
    const viaLimits = await windowsFor({ limits: [scoped(model("Omelette"), 12)] });
    expect(viaLegacy[0]?.id).toBe(viaLimits[0]?.id);
  });

  it("ordering and unscoped windows: puts session and weekly ahead of the scoped bars", async () => {
    const windows = await windowsFor({
      five_hour: { utilization: 6, resets_at: RESETS },
      seven_day: { utilization: 23, resets_at: RESETS },
      seven_day_opus: { utilization: 8, resets_at: RESETS },
      limits: [
        { kind: "session", percent: 6, resets_at: RESETS, scope: null },
        { kind: "weekly_all", percent: 23, resets_at: RESETS, scope: null },
        scoped(model("Fable"), 2),
      ],
    });
    expect(windows.map((w) => w.id)).toEqual([
      "five_hour",
      "weekly",
      "weekly_model_opus",
      "weekly_model_fable",
    ]);
  });
});

describe("KimiQuotaProvider usage windows", () => {
  afterEach(() => {
    delete process.env["KIMI_TOKEN"];
    vi.restoreAllMocks();
  });

  it("normalizes weekly and enforced rolling usage windows", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        limited: true,
        usage: {
          limit: "100",
          used: "61",
          remaining: "39",
          resetTime: "2026-08-05T00:01:45Z",
        },
        limits: [
          {
            window: {
              duration: 300,
              timeUnit: "TIME_UNIT_MINUTE",
            },
            detail: {
              limit: "100",
              used: "100",
              resetTime: "2026-07-31T17:01:45Z",
            },
          },
        ],
      }),
    );
    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage).toMatchObject({
      status: "available",
      windows: [
        {
          id: "coding_usage",
          label: "Weekly limit",
          usedPct: 61,
          remainingPct: 39,
          resetsAt: "2026-08-05T00:01:45Z",
          tone: "ok",
        },
        {
          id: "coding_limit_300_time_unit_minute",
          label: "5-hour limit",
          usedPct: 100,
          remainingPct: 0,
          resetsAt: "2026-07-31T17:01:45Z",
          tone: "danger",
        },
      ],
    });
  });

  it("keeps valid windows when another limits entry is malformed", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const logger = createLogger() as unknown as { debug: ReturnType<typeof vi.fn> };
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        usage: {
          limit: "100",
          remaining: "75",
          resetTime: "2026-08-05T00:01:45Z",
        },
        limits: [
          { window: { duration: "invalid" }, detail: {} },
          {
            window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            detail: { limit: "100", remaining: "50" },
          },
        ],
      }),
    );
    const provider = new KimiQuotaProvider({ logger: logger as never, fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toHaveLength(2);
    expect(usage.windows[1]).toMatchObject({
      label: "5-hour limit",
      usedPct: 50,
      remainingPct: 50,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      { index: 0 },
      "Ignoring malformed Kimi usage limit window",
    );
  });

  it("accepts direct limit fields, alternate reset keys, and provider labels", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const fetchApi = vi.fn(async () =>
      jsonResponse({
        usage: null,
        limits: [
          {
            name: "Burst quota",
            limit: "80",
            remaining: "20",
            reset_at: "2026-08-01T00:00:00Z",
          },
        ],
      }),
    );
    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toEqual([
      expect.objectContaining({
        id: "coding_limit_burst_quota",
        label: "Burst quota",
        usedPct: 75,
        remainingPct: 25,
        resetsAt: "2026-08-01T00:00:00Z",
      }),
    ]);
  });

  it("keeps window ids unique when Kimi returns duplicate limit descriptors", async () => {
    process.env["KIMI_TOKEN"] = "kimi_test_token";
    const duplicate = {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: { limit: "100", used: "10" },
    };
    const fetchApi = vi.fn(async () => jsonResponse({ limits: [duplicate, duplicate] }));
    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => window.id)).toEqual([
      "coding_limit_300_time_unit_minute",
      "coding_limit_300_time_unit_minute_2",
    ]);
  });
});
