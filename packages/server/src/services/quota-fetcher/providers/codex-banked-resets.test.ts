import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ProviderUsageService } from "../service.js";
import { CodexQuotaProvider } from "./codex.js";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "codex-resets-"));
  vi.stubEnv("CODEX_HOME", home);
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      tokens: { access_token: "test-token", account_id: "test-account" },
    }),
  );
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

test("loads banked reset details alongside usage", async () => {
  const fetchApi = vi.fn<typeof fetch>(async (url) => {
    if (url.toString().endsWith("/usage")) {
      return Response.json({ rate_limit_reset_credits: { available_count: 1 } });
    }
    return Response.json({
      available_count: 1,
      credits: [
        {
          id: "reset-1",
          reset_type: "codex_rate_limits",
          status: "available",
          granted_at: "2026-09-01T00:00:00Z",
          expires_at: "2026-10-01T00:00:00Z",
          title: "Referral reward",
          description: null,
        },
      ],
    });
  });
  const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
  const usage = await provider.fetchUsage();
  expect(usage.bankedResets).toEqual({
    availableCount: 1,
    error: null,
    credits: [
      {
        id: "reset-1",
        resetType: "codex_rate_limits",
        supportedByPlan: null,
        status: "available",
        grantedAt: "2026-09-01T00:00:00Z",
        expiresAt: "2026-10-01T00:00:00Z",
        title: "Referral reward",
        description: null,
      },
    ],
  });
  expect(fetchApi).toHaveBeenLastCalledWith(
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits",
    expect.objectContaining({
      headers: expect.objectContaining({
        Authorization: "Bearer test-token",
        "ChatGPT-Account-Id": "test-account",
      }),
    }),
  );
});

test.each(["reset", "nothing_to_reset", "no_credit", "already_redeemed"])(
  "redeems a selected reset and returns %s without retrying",
  async (code) => {
    const fetchApi = vi.fn<typeof fetch>(async () => Response.json({ code }));
    const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
    await expect(
      provider.consumeBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" }),
    ).resolves.toBe(code);
    expect(fetchApi).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ credit_id: "reset-1", redeem_request_id: "attempt-1" }),
      }),
    );
  },
);

test("detail failures preserve the reset count and quota windows", async () => {
  const fetchApi = vi.fn<typeof fetch>(async (url) => {
    if (url.toString().endsWith("/usage")) {
      return Response.json({
        rate_limit: { primary_window: { used_percent: 42 } },
        rate_limit_reset_credits: { available_count: 2 },
      });
    }
    return new Response("unavailable", { status: 503 });
  });
  const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
  const usage = await provider.fetchUsage();
  expect(usage.status).toBe("available");
  expect(usage.windows[0].usedPct).toBe(42);
  expect(usage.bankedResets).toEqual({
    availableCount: 2,
    credits: null,
    error: "Could not load banked reset details. Refresh usage to try again.",
  });
});

test("consume failure is surfaced without a second POST", async () => {
  const fetchApi = vi.fn<typeof fetch>(async () => new Response("unavailable", { status: 503 }));
  const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
  await expect(
    provider.consumeBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" }),
  ).rejects.toThrow("Codex banked reset API returned 503");
  expect(fetchApi).toHaveBeenCalledTimes(1);
});

test("redemption invalidates usage cached before the reset", async () => {
  let usedPercent = 100;
  const fetchApi = vi.fn<typeof fetch>(async (url) => {
    if (url.toString().endsWith("/consume")) {
      usedPercent = 0;
      return Response.json({ code: "reset" });
    }
    return Response.json({ rate_limit: { primary_window: { used_percent: usedPercent } } });
  });
  const logger = pino({ enabled: false });
  const provider = new CodexQuotaProvider({ logger, fetch: fetchApi });
  const service = new ProviderUsageService({ logger, fetchers: [provider] });
  expect((await service.listUsage()).providers[0].windows[0].usedPct).toBe(100);
  await expect(
    service.consumeCodexBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" }),
  ).resolves.toBe("reset");
  expect((await service.listUsage()).providers[0].windows[0].usedPct).toBe(0);
});

test("a pre-reset read cannot overwrite the refreshed usage cache", async () => {
  let completeOldRead!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    completeOldRead = resolve;
  });
  let reads = 0;
  const fetchApi = vi.fn<typeof fetch>(async (url) => {
    if (url.toString().endsWith("/consume")) return Response.json({ code: "reset" });
    reads += 1;
    if (reads === 1) return oldResponse;
    return Response.json({ rate_limit: { primary_window: { used_percent: 0 } } });
  });
  const logger = pino({ enabled: false });
  const service = new ProviderUsageService({
    logger,
    fetchers: [new CodexQuotaProvider({ logger, fetch: fetchApi })],
  });
  const staleRead = service.listUsage();
  await vi.waitFor(() => expect(reads).toBe(1));
  await service.consumeCodexBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" });
  expect((await service.listUsage()).providers[0].windows[0].usedPct).toBe(0);
  completeOldRead(Response.json({ rate_limit: { primary_window: { used_percent: 100 } } }));
  await staleRead;
  expect((await service.listUsage()).providers[0].windows[0].usedPct).toBe(0);
  expect(reads).toBe(2);
});

test("a failed POST invalidates usage because the reset may have happened", async () => {
  let usedPercent = 100;
  const fetchApi = vi.fn<typeof fetch>(async (url) => {
    if (url.toString().endsWith("/consume")) {
      usedPercent = 0;
      throw new TypeError("Network connection lost");
    }
    return Response.json({ rate_limit: { primary_window: { used_percent: usedPercent } } });
  });
  const logger = pino({ enabled: false });
  const service = new ProviderUsageService({
    logger,
    fetchers: [new CodexQuotaProvider({ logger, fetch: fetchApi })],
  });
  await service.listUsage();
  await expect(
    service.consumeCodexBankedReset({ creditId: "reset-1", idempotencyKey: "attempt-1" }),
  ).rejects.toThrow("Network connection lost");
  expect((await service.listUsage()).providers[0].windows[0].usedPct).toBe(0);
});

test.each([
  new TypeError("Unexpected reset adapter defect"),
  new SyntaxError("Invalid reset response JSON"),
])("unexpected reset detail errors propagate: %s", async (error) => {
  const fetchApi: typeof fetch = async (url) => {
    if (url.toString().endsWith("/usage")) {
      return Response.json({ rate_limit_reset_credits: { available_count: 1 } });
    }
    throw error;
  };
  const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
  await expect(provider.fetchUsage()).rejects.toBe(error);
});

test("invalid reset details propagate the schema error", async () => {
  const fetchApi: typeof fetch = async (url) => {
    if (url.toString().endsWith("/usage")) {
      return Response.json({ rate_limit_reset_credits: { available_count: 1 } });
    }
    return Response.json({ available_count: 1, credits: "invalid" });
  };
  const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
  await expect(provider.fetchUsage()).rejects.toThrow("Invalid input: expected array");
});

test.each([
  new TypeError("fetch failed"),
  new DOMException("Request timed out", "TimeoutError"),
  new DOMException("Request aborted", "AbortError"),
])("expected reset transport failures preserve quota: %s", async (error) => {
  const fetchApi: typeof fetch = async (url) => {
    if (url.toString().endsWith("/usage")) {
      return Response.json({
        rate_limit: { primary_window: { used_percent: 75 } },
        rate_limit_reset_credits: { available_count: 1 },
      });
    }
    throw error;
  };
  const provider = new CodexQuotaProvider({ logger: pino({ enabled: false }), fetch: fetchApi });
  const usage = await provider.fetchUsage();
  expect(usage.windows[0].usedPct).toBe(75);
  expect(usage.bankedResets).toEqual({
    availableCount: 1,
    credits: null,
    error: "Could not load banked reset details. Refresh usage to try again.",
  });
});
