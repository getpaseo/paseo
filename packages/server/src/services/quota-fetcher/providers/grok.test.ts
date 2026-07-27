import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { GrokQuotaProvider } from "./grok.js";

const temporaryDirectories: string[] = [];

async function createGrokHome(): Promise<string> {
  const grokHome = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-grok-usage-"));
  temporaryDirectories.push(grokHome);
  return grokHome;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await fs.rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("GrokQuotaProvider", () => {
  test("reads the current Grok CLI credential store and billing counters", async () => {
    const grokHome = await createGrokHome();
    await fs.writeFile(
      path.join(grokHome, "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::account": {
          key: "grok_cli_token",
          email: "person@example.test",
          first_name: "Test",
          last_name: "Account",
          principal_type: "user",
        },
      }),
    );
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer grok_cli_token" });
      const url = input.toString();
      if (url.endsWith("/v1/settings")) {
        return new Response(JSON.stringify({ subscription_tier_display: "SuperGrok Heavy" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ config: { monthlyLimit: { val: 100 }, used: { val: 25 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const provider = new GrokQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchApi,
      grokHome,
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "available",
      planLabel: "SuperGrok Heavy",
      balances: [expect.objectContaining({ used: 25, remaining: 75, limit: 100 })],
      details: [
        { id: "account_email", label: "Account email", value: "person@example.test" },
        { id: "account_name", label: "Account", value: "Test Account" },
        { id: "account_type", label: "Account type", value: "user" },
      ],
    });
  });

  test("refreshes an expired CLI credential before requesting usage", async () => {
    const grokHome = await createGrokHome();
    const authPath = path.join(grokHome, "auth.json");
    await fs.writeFile(
      authPath,
      JSON.stringify({
        "https://auth.x.ai::account": {
          key: "expired_token",
          expires_at: "2020-01-01T00:00:00.000Z",
          refresh_token: "refresh_token",
        },
      }),
    );
    const refreshAuth = vi.fn(async () => {
      await fs.writeFile(
        authPath,
        JSON.stringify({
          "https://auth.x.ai::account": {
            key: "refreshed_token",
            expires_at: "2099-01-01T00:00:00.000Z",
            refresh_token: "refresh_token",
          },
        }),
      );
    });
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: "Bearer refreshed_token" });
      if (input.toString().endsWith("/v1/settings")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ config: { monthlyLimit: { val: 100 } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const provider = new GrokQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchApi,
      grokHome,
      refreshAuth,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({ status: "available" });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledTimes(2);
  });

  test("refreshes and retries once when the billing endpoint rejects a cached credential", async () => {
    const grokHome = await createGrokHome();
    const authPath = path.join(grokHome, "auth.json");
    await fs.writeFile(
      authPath,
      JSON.stringify({
        "https://auth.x.ai::account": {
          key: "stale_token",
          expires_at: "2099-01-01T00:00:00.000Z",
          refresh_token: "refresh_token",
        },
      }),
    );
    const refreshAuth = vi.fn(async () => {
      await fs.writeFile(
        authPath,
        JSON.stringify({
          "https://auth.x.ai::account": {
            key: "fresh_token",
            expires_at: "2099-01-01T00:00:00.000Z",
            refresh_token: "refresh_token",
          },
        }),
      );
    });
    let billingCalls = 0;
    const fetchApi = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/v1/settings")) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer fresh_token" });
        return new Response(JSON.stringify({ subscription_tier_display: "SuperGrok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      billingCalls += 1;
      if (billingCalls === 1) {
        expect(init?.headers).toMatchObject({ Authorization: "Bearer stale_token" });
        return new Response(null, { status: 401 });
      }
      expect(init?.headers).toMatchObject({ Authorization: "Bearer fresh_token" });
      return new Response(
        JSON.stringify({ config: { monthlyLimit: { val: 100 }, used: { val: 25 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const provider = new GrokQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchApi,
      grokHome,
      refreshAuth,
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "available",
      planLabel: "SuperGrok",
      balances: [expect.objectContaining({ used: 25, remaining: 75 })],
    });
    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchApi).toHaveBeenCalledTimes(3);
  });

  test("retries transient billing fetch failures before succeeding", async () => {
    const grokHome = await createGrokHome();
    await fs.writeFile(
      path.join(grokHome, "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::account": {
          key: "grok_cli_token",
        },
      }),
    );
    let billingCalls = 0;
    const fetchApi = vi.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.endsWith("/v1/settings")) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      billingCalls += 1;
      if (billingCalls < 3) {
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      }
      return new Response(
        JSON.stringify({ config: { monthlyLimit: { val: 100 }, used: { val: 10 } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const provider = new GrokQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchApi,
      grokHome,
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "available",
      balances: [expect.objectContaining({ used: 10, remaining: 90 })],
    });
    expect(billingCalls).toBe(3);
  });

  test("surfaces a clear error when billing stays unreachable", async () => {
    const grokHome = await createGrokHome();
    await fs.writeFile(
      path.join(grokHome, "auth.json"),
      JSON.stringify({
        "https://auth.x.ai::account": {
          key: "grok_cli_token",
          email: "person@example.test",
        },
      }),
    );
    const fetchApi = vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
    }) as unknown as typeof fetch;
    const provider = new GrokQuotaProvider({
      logger: createTestLogger(),
      fetch: fetchApi,
      grokHome,
      proxyBaseUrl: "https://proxy.example.test/v1",
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      status: "error",
      details: [{ id: "account_email", value: "person@example.test" }],
      error: expect.stringContaining("Couldn't reach Grok billing API"),
    });
    expect(fetchApi.mock.calls[0]?.[0]).toBe("https://proxy.example.test/v1/billing");
  });
});
