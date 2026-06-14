import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuotaFetcherService } from "./quota-fetcher.js";
import type { ProviderQuotaMessage } from "../server/messages.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeCreds(
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

function makeClaudeResponse(
  overrides: Partial<{
    five_hour: { utilization: number; resets_at: string };
    seven_day: { utilization: number; resets_at: string };
    seven_day_opus: { utilization: number; resets_at: string };
  }> = {},
) {
  return {
    five_hour: { utilization: 11.0, resets_at: "2026-06-01T21:00:00Z" },
    seven_day: { utilization: 1.0, resets_at: "2026-06-04T00:00:00Z" },
    seven_day_opus: { utilization: 0.5, resets_at: "2026-06-04T00:00:00Z" },
    ...overrides,
  };
}

function makeCodexResponse(overrides: object = {}) {
  return {
    plan_type: "plus",
    email: "user@example.com",
    rate_limit: {
      primary_window: { used_percent: 42, reset_at: 1748812800 },
      secondary_window: { used_percent: 8, reset_at: 1749072000 },
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QuotaFetcherService", () => {
  let claudeHome: string;
  let codexHome: string;
  let broadcasts: ProviderQuotaMessage[];
  let service: QuotaFetcherService;
  let originalFetch: typeof fetch;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "quota-test-claude-"));
    codexHome = mkdtempSync(join(tmpdir(), "quota-test-codex-"));
    broadcasts = [];
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };

    const envVarsToClear = [
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
    ];
    for (const key of envVarsToClear) {
      delete process.env[key];
    }

    service = new QuotaFetcherService({
      broadcast: (msg) => broadcasts.push(msg),
      logger: {
        child: () => ({ debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() }),
      } as never,
      claudeHome,
      claudeKeychainReader: async () => null,
      codexHome,
      pollIntervalMs: 999_999,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    service.stop();
    rmSync(claudeHome, { recursive: true, force: true });
    rmSync(codexHome, { recursive: true, force: true });

    for (const key in originalEnv) {
      process.env[key] = originalEnv[key];
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
  });

  // ── Claude ─────────────────────────────────────────────────────────────

  describe("Claude quota", () => {
    it("returns quota windows when credentials exist and API succeeds", async () => {
      writeCreds(claudeHome, "at_valid");
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
        ]),
      );

      await service.triggerFetch();

      expect(broadcasts).toHaveLength(1);
      const { claude } = broadcasts[0].payload;
      expect(claude?.fiveHour?.utilizationPct).toBe(11.0);
      expect(claude?.sevenDay?.utilizationPct).toBe(1.0);
      expect(claude?.sevenDayOpus?.utilizationPct).toBe(0.5);
      expect(claude?.plan).toBe("Pro 1x");
    });

    it("does not call Claude when credentials file is missing", async () => {
      // no writeCreds — file absent
      globalThis.fetch = vi.fn() as never; // should not be called

      await service.triggerFetch();

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].payload.claude).toBeUndefined();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("refreshes access token on 401 and retries", async () => {
      writeCreds(claudeHome, "at_expired", "rt_valid");
      let callCount = 0;
      async function handleRefreshFlow(url: RequestInfo | URL) {
        const u = url.toString();
        if (u === "https://api.anthropic.com/api/oauth/usage") {
          callCount++;
          if (callCount === 1) return new Response(null, { status: 401 });
          return jsonResponse(makeClaudeResponse());
        }
        if (u === "https://platform.claude.com/v1/oauth/token") {
          return jsonResponse({ access_token: "at_refreshed", refresh_token: "rt_new" });
        }
        throw new Error(`Unmocked: ${u}`);
      }
      globalThis.fetch = vi.fn(handleRefreshFlow) as never;

      await service.triggerFetch();

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].payload.claude?.fiveHour?.utilizationPct).toBe(11.0);
      expect(callCount).toBe(2);
    });

    it("returns no Claude data when 401 persists after token refresh", async () => {
      writeCreds(claudeHome, "at_bad", "rt_bad");
      async function handlePersistentAuth(url: RequestInfo | URL) {
        const u = url.toString();
        if (u === "https://api.anthropic.com/api/oauth/usage")
          return new Response(null, { status: 401 });
        if (u === "https://platform.claude.com/v1/oauth/token") {
          return jsonResponse({ access_token: "at_still_bad", refresh_token: "rt_still_bad" });
        }
        throw new Error(`Unmocked: ${u}`);
      }
      globalThis.fetch = vi.fn(handlePersistentAuth) as never;

      await service.triggerFetch();

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].payload.claude).toBeUndefined();
    });
  });

  // ── Codex ──────────────────────────────────────────────────────────────

  describe("Codex quota", () => {
    it("returns quota windows when auth file exists and API succeeds", async () => {
      writeCreds(claudeHome, "at_claude"); // need Claude too so broadcast fires
      writeCodexAuth(codexHome, "at_codex_valid");
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
          ["https://chatgpt.com/backend-api/wham/usage", () => jsonResponse(makeCodexResponse())],
        ]),
      );

      await service.triggerFetch();

      const { codex } = broadcasts[0].payload;
      expect(codex?.session?.utilizationPct).toBe(42);
      expect(codex?.weekly?.utilizationPct).toBe(8);
      expect(codex?.planType).toBe("plus");
      expect(codex?.email).toBe("user@example.com");
    });

    it("treats HTML response as auth failure and skips", async () => {
      writeCreds(claudeHome, "at_claude");
      writeCodexAuth(codexHome, "at_codex_stale");
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
          [
            "https://chatgpt.com/backend-api/wham/usage",
            () => new Response("<html>Login</html>", { status: 200 }),
          ],
          ["https://auth.openai.com/oauth/token", () => new Response(null, { status: 401 })],
        ]),
      );

      await service.triggerFetch();

      expect(broadcasts[0].payload.codex).toBeUndefined();
    });

    it("persists refreshed tokens to the Codex auth file that was read", async () => {
      writeCreds(claudeHome, "at_claude");
      const alternateCodexHome = mkdtempSync(join(tmpdir(), "quota-test-codex-alt-"));
      process.env["CODEX_HOME"] = alternateCodexHome;
      writeFileSync(join(alternateCodexHome, "auth.json"), JSON.stringify({ tokens: {} }));
      writeCodexAuth(codexHome, "at_codex_stale", "rt_codex_valid");

      let usageCalls = 0;
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
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
        await service.triggerFetch();

        const refreshedAuth = JSON.parse(readFileSync(join(codexHome, "auth.json"), "utf8"));
        const untouchedAuth = JSON.parse(
          readFileSync(join(alternateCodexHome, "auth.json"), "utf8"),
        );
        expect(refreshedAuth.tokens.access_token).toBe("at_codex_fresh");
        expect(refreshedAuth.tokens.refresh_token).toBe("rt_codex_fresh");
        expect(untouchedAuth.tokens.access_token).toBeUndefined();
      } finally {
        rmSync(alternateCodexHome, { recursive: true, force: true });
      }
    });
  });

  // ── New Providers ──────────────────────────────────────────────────────

  describe("New Providers", () => {
    it("returns copilot quota when COPILOT_TOKEN is set and API succeeds", async () => {
      writeCreds(claudeHome, "at_valid"); // need Claude too so broadcast fires
      process.env["COPILOT_TOKEN"] = "copilot_test_token";
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
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

      await service.triggerFetch();

      const { copilot } = broadcasts[0].payload;
      expect(copilot?.plan).toBe("business");
      expect(copilot?.quotaResetDate).toBe("2026-07-01T00:00:00Z");
    });

    it("returns cursor quota when CURSOR_ACCESS_TOKEN is set and API succeeds", async () => {
      writeCreds(claudeHome, "at_valid");
      process.env["CURSOR_ACCESS_TOKEN"] = "cursor_test_token";
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
          [
            "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
            () =>
              jsonResponse({
                planUsage: {
                  totalSpend: 1500,
                  includedSpend: 1000,
                  bonusSpend: 500,
                  remaining: 2500,
                  limit: 4000,
                },
                billingCycleStart: "1768399334000",
                billingCycleEnd: "1771077734000",
              }),
          ],
        ]),
      );

      await service.triggerFetch();

      const { cursor } = broadcasts[0].payload;
      expect(cursor?.planUsage?.totalSpend).toBe(15);
      expect(cursor?.planUsage?.limit).toBe(40);
      expect(cursor?.planUsage?.remaining).toBe(25);
      expect(cursor?.billingCycleEnd).toBe(new Date(1771077734000).toISOString());
    });

    it("returns zai quota when ZAI_API_KEY is set and API succeeds", async () => {
      writeCreds(claudeHome, "at_valid");
      process.env["ZAI_API_KEY"] = "zai_test_token";
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
          [
            "https://api.z.ai/api/biz/subscription/list",
            () =>
              jsonResponse({
                code: 200,
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

      await service.triggerFetch();

      const { zai } = broadcasts[0].payload;
      expect(zai?.productName).toBe("GLM Coding Max");
      expect(zai?.status).toBe("VALID");
    });

    it("returns grok quota when GROK_API_KEY is set and API succeeds", async () => {
      writeCreds(claudeHome, "at_valid");
      process.env["GROK_API_KEY"] = "grok_test_token";
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
          [
            "https://cli-chat-proxy.grok.com/v1/billing",
            () =>
              jsonResponse({
                config: { monthlyLimit: { val: 60000 } },
                usage: { creditUsage: 12000 },
              }),
          ],
        ]),
      );

      await service.triggerFetch();

      const { grok } = broadcasts[0].payload;
      expect(grok?.monthlyLimit).toBe(60000);
      expect(grok?.creditUsage).toBe(12000);
    });

    it("preserves zero values from Grok quota responses", async () => {
      writeCreds(claudeHome, "at_valid");
      process.env["GROK_API_KEY"] = "grok_test_token";
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
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

      await service.triggerFetch();

      const { grok } = broadcasts[0].payload;
      expect(grok?.monthlyLimit).toBe(0);
      expect(grok?.creditUsage).toBe(0);
    });

    it("returns kimi quota when KIMI_TOKEN is set and API succeeds", async () => {
      writeCreds(claudeHome, "at_valid");
      process.env["KIMI_TOKEN"] = "kimi_test_token";
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
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

      await service.triggerFetch();

      const { kimi } = broadcasts[0].payload;
      expect(kimi?.limit).toBe("100");
      expect(kimi?.remaining).toBe("74");
      expect(kimi?.resetTime).toBe("2026-02-11T17:32:50Z");
    });
  });

  // ── Broadcast behaviour ────────────────────────────────────────────────

  describe("broadcast deduplication", () => {
    it("broadcasts a fetched marker when no provider has quota data", async () => {
      globalThis.fetch = mockFetch(new Map());

      await service.triggerFetch();

      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({
        type: "provider_quota",
        payload: {
          fetchedAt: expect.any(String),
        },
      });
    });

    it("broadcasts only once when payload is unchanged", async () => {
      writeCreds(claudeHome, "at_valid");
      globalThis.fetch = mockFetch(
        new Map([
          ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
        ]),
      );

      await service.triggerFetch();
      await service.triggerFetch();

      expect(broadcasts).toHaveLength(1);
    });

    it("broadcasts again when payload changes", async () => {
      writeCreds(claudeHome, "at_valid");
      let utilization = 11.0;
      async function fetchWithUtilization() {
        return jsonResponse(
          makeClaudeResponse({ five_hour: { utilization, resets_at: "2026-06-01T21:00:00Z" } }),
        );
      }
      globalThis.fetch = vi.fn(fetchWithUtilization) as never;

      await service.triggerFetch();
      utilization = 25.0;
      await service.triggerFetch();

      expect(broadcasts).toHaveLength(2);
      expect(broadcasts[1].payload.claude?.fiveHour?.utilizationPct).toBe(25.0);
    });
  });

  // ── getCached ──────────────────────────────────────────────────────────

  it("getCached returns null before first fetch", () => {
    expect(service.getCached()).toBeNull();
  });

  it("getCached returns last broadcast message after fetch", async () => {
    writeCreds(claudeHome, "at_valid");
    globalThis.fetch = mockFetch(
      new Map([
        ["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(makeClaudeResponse())],
      ]),
    );

    await service.triggerFetch();

    const cached = service.getCached();
    expect(cached?.type).toBe("provider_quota");
    expect(cached?.payload.claude?.fiveHour?.utilizationPct).toBe(11.0);
  });
});
