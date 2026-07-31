import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KimiQuotaProvider } from "./kimi.js";

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

describe("KimiQuotaProvider", () => {
  let homeDir: string;
  let credentialPath: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "kimi-quota-test-"));
    credentialPath = join(homeDir, ".kimi-code", "credentials", "kimi-code.json");
    mkdirSync(join(homeDir, ".kimi-code", "credentials"), { recursive: true });
    originalEnv = { ...process.env };
    delete process.env["KIMI_TOKEN"];
    delete process.env["KIMI_API_KEY"];
    delete process.env["KIMI_CODE_HOME"];
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key in originalEnv) process.env[key] = originalEnv[key];
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
  });

  it("refreshes a rejected file-backed token, persists it, and retries usage once", async () => {
    writeFileSync(
      credentialPath,
      JSON.stringify({
        access_token: "at_expired",
        refresh_token: "rt_valid",
        expires_at: 1,
        expires_in: 900,
        scope: "kimi-code",
        token_type: "Bearer",
        preserved_field: "keep-me",
      }),
    );

    const authorization: string[] = [];
    const fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.kimi.com/coding/v1/usages") {
        authorization.push((init?.headers as Record<string, string>).Authorization);
        if (authorization.length === 1) return new Response(null, { status: 401 });
        return jsonResponse({
          usage: { limit: "100", remaining: "74", resetTime: "2026-08-01T00:00:00Z" },
        });
      }
      if (endpoint === "https://auth.kimi.com/api/oauth/token") {
        expect(init?.method).toBe("POST");
        expect(init?.body?.toString()).toContain("grant_type=refresh_token");
        expect(init?.body?.toString()).toContain("refresh_token=rt_valid");
        return jsonResponse({
          access_token: "at_fresh",
          refresh_token: "rt_rotated",
          expires_in: 900,
          scope: "kimi-code",
          token_type: "Bearer",
        });
      }
      throw new Error(`Unmocked fetch: ${endpoint}`);
    }) as unknown as typeof fetch;

    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });
    const result = await provider.fetchUsage();
    const persisted = JSON.parse(readFileSync(credentialPath, "utf8"));

    expect(result).toMatchObject({
      status: "available",
      windows: [expect.objectContaining({ id: "coding_usage", usedPct: 26 })],
    });
    expect(authorization).toEqual(["Bearer at_expired", "Bearer at_fresh"]);
    expect(persisted).toMatchObject({
      access_token: "at_fresh",
      refresh_token: "rt_rotated",
      expires_in: 900,
      preserved_field: "keep-me",
    });
    expect(persisted.expires_at).toBeGreaterThan(Date.now() / 1000);
  });

  it("uses a token refreshed by Kimi Code while the first usage request is in flight", async () => {
    writeFileSync(
      credentialPath,
      JSON.stringify({ access_token: "at_old", refresh_token: "rt_valid" }),
    );

    let usageCalls = 0;
    let refreshCalls = 0;
    const fetchApi = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.kimi.com/coding/v1/usages") {
        usageCalls += 1;
        if (usageCalls === 1) {
          writeFileSync(
            credentialPath,
            JSON.stringify({ access_token: "at_kimi_refreshed", refresh_token: "rt_new" }),
          );
          return new Response(null, { status: 401 });
        }
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer at_kimi_refreshed",
        );
        return jsonResponse({ usage: { limit: "100", remaining: "50" } });
      }
      if (endpoint === "https://auth.kimi.com/api/oauth/token") {
        refreshCalls += 1;
      }
      throw new Error(`Unexpected fetch: ${endpoint}`);
    }) as unknown as typeof fetch;

    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });
    const result = await provider.fetchUsage();

    expect(result.status).toBe("available");
    expect(usageCalls).toBe(2);
    expect(refreshCalls).toBe(0);
  });

  it("does not attempt OAuth refresh for environment-provided tokens", async () => {
    process.env["KIMI_TOKEN"] = "at_environment";
    const fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      expect(url.toString()).toBe("https://api.kimi.com/coding/v1/usages");
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;

    const provider = new KimiQuotaProvider({ logger: createLogger(), fetch: fetchApi, homeDir });
    const result = await provider.fetchUsage();

    expect(result.status).toBe("unavailable");
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });
});
