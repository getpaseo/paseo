import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import { decryptCredential } from "./zcode-credentials.js";

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

const QUOTA_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

function quotaResponse(limits: unknown[]) {
  return jsonResponse({ code: 200, msg: "Operation successful", data: { level: "pro", limits } });
}

describe("zai usage source", () => {
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), "usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    process.env["ZCODE_DATA_BASE_DIR"] = homeDir;
    for (const key of [
      "APPDATA",
      "COPILOT_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "CURSOR_ACCESS_TOKEN",
      "CURSOR_TOKEN",
      "Z_AI_API_KEY",
      "ZAI_API_KEY",
      "GLM_API_KEY",
      "GROK_API_KEY",
      "GROK_TOKEN",
      "KIMI_TOKEN",
      "KIMI_API_KEY",
      "KIMI_CODE_HOME",
      "MINIMAX_API_KEY",
      "MINIMAX_BASE_URL",
      "XDG_CONFIG_HOME",
      "ZCODE_CREDENTIAL_SECRET",
    ])
      delete process.env[key];
    fetchApi = mockFetch(new Map());
  });
  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("reads the quota windows from the coding-plan endpoint", async () => {
    process.env["Z_AI_API_KEY"] = "zai_test_token";
    let authorization: string | null = null;
    let quotaUrl: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = url.toString();
      if (target === QUOTA_URL) {
        quotaUrl = target;
        authorization =
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
        return quotaResponse([
          {
            type: "CREDIT_LIMIT",
            unit: 3,
            number: 5,
            usage: 12000,
            currentValue: 900,
            remaining: 11100,
            percentage: 7,
            nextResetTime: 1793426841895,
          },
          {
            type: "CREDIT_LIMIT",
            unit: 6,
            number: 1,
            usage: 60000,
            currentValue: 24600,
            remaining: 35400,
            percentage: 41,
            nextResetTime: 1793923437984,
          },
        ]);
      }
      return jsonResponse({
        data: [
          {
            productName: "GLM Coding Pro",
            status: "VALID",
            purchaseTime: "2026-09-14 15:52:38",
            valid: "2027-09-14 10:00:00-2028-09-14 10:00:00",
          },
        ],
      });
    }) as unknown as typeof fetch;

    const report = await fetchUsage({ store: "env", locator: "Z_AI_API_KEY" }, fetchApi);

    expect(quotaUrl).toBe(QUOTA_URL);
    // The monitor endpoint takes the credential as-is and rejects a Bearer prefix.
    expect(authorization).toBe("zai_test_token");
    expect(report).toMatchObject({
      status: "available",
      planLabel: "GLM Coding Pro",
      windows: expect.arrayContaining([
        expect.objectContaining({ label: "5-hour limit", usedPct: 93, remainingPct: 7 }),
        expect.objectContaining({ label: "Weekly limit", usedPct: 59, remainingPct: 41 }),
      ]),
      details: expect.arrayContaining([{ id: "status", label: "Status", value: "VALID" }]),
    });
  });

  it("reports an account without a coding plan as unavailable", async () => {
    process.env["Z_AI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          QUOTA_URL,
          () => jsonResponse({ code: 1004, msg: "current user does not exist coding plan" }),
        ],
      ]),
    );

    const report = await fetchUsage({ store: "env", locator: "Z_AI_API_KEY" }, fetchApi);

    expect(report).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });
  });

  it("reports a rejected login", async () => {
    process.env["Z_AI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(new Map([[QUOTA_URL, () => new Response(null, { status: 401 })]]));

    const report = await fetchUsage({ store: "env", locator: "Z_AI_API_KEY" }, fetchApi);

    expect(report).toMatchObject({
      status: "unavailable",
      problem: { kind: "rejected", status: 401 },
    });
  });

  it("keeps the quota when the subscription list is unavailable", async () => {
    process.env["Z_AI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          QUOTA_URL,
          () =>
            quotaResponse([
              {
                type: "TOKENS_LIMIT",
                unit: 3,
                number: 5,
                usage: 100,
                currentValue: 25,
                percentage: 75,
              },
            ]),
        ],
      ]),
    );

    const report = await fetchUsage({ store: "env", locator: "Z_AI_API_KEY" }, fetchApi);

    expect(report).toMatchObject({ status: "available" });
    expect(report.status === "available" ? report.windows[0] : null).toMatchObject({
      usedPct: 25,
      remainingPct: 75,
    });
  });

  it("ignores tool quota limits", async () => {
    process.env["Z_AI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          QUOTA_URL,
          () =>
            quotaResponse([
              {
                type: "TIME_LIMIT",
                unit: 4,
                number: 1,
                usage: 100,
                currentValue: 10,
                percentage: 90,
              },
            ]),
        ],
      ]),
    );

    const report = await fetchUsage({ store: "env", locator: "Z_AI_API_KEY" }, fetchApi);

    expect(report).toMatchObject({ status: "unavailable", problem: { kind: "no_quota" } });
  });

  it("discovers the coding plan key from the ZCode credential store", async () => {
    const credentialsDir = join(homeDir, ".zcode", "v2");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      join(credentialsDir, "credentials.json"),
      JSON.stringify({
        "account-provider:coding-plan:account:123:api-key": "zcode_api_key",
      }),
    );

    const accounts = await discover();

    expect(accounts).toEqual([{ key: "default", input: { store: "zcode", locator: "api-key" } }]);
  });

  it("reads the quota with the key from the ZCode credential store", async () => {
    const credentialsDir = join(homeDir, ".zcode", "v2");
    mkdirSync(credentialsDir, { recursive: true });
    writeFileSync(
      join(credentialsDir, "credentials.json"),
      JSON.stringify({
        "account-provider:coding-plan:account:123:api-key": "zcode_api_key",
      }),
    );
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url.toString() === QUOTA_URL) {
        authorization =
          (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
        return quotaResponse([
          {
            type: "CREDIT_LIMIT",
            unit: 6,
            number: 1,
            usage: 100,
            currentValue: 40,
            percentage: 60,
          },
        ]);
      }
      return jsonResponse({ data: [{ productName: "GLM Coding Pro", status: "VALID" }] });
    }) as unknown as typeof fetch;

    const accounts = await discover();
    const report = await fetchUsage(
      accounts[0]?.input as Parameters<typeof fetchUsage>[0],
      fetchApi,
    );

    expect(authorization).toBe("zcode_api_key");
    expect(report).toMatchObject({ status: "available", planLabel: "GLM Coding Pro" });
  });
});

describe("ZCode credential decryption", () => {
  it("returns a value that is not encrypted unchanged", () => {
    expect(decryptCredential("plain-value", {})).toBe("plain-value");
  });

  it("decrypts a value the ZCode app encrypted for this machine", () => {
    // The app encrypts with AES-256-GCM under a key derived from the machine
    // secret. Encrypting here the same way and decrypting back proves the
    // derivation and the layout match.
    const secret = "a-secret";
    const key = createHash("sha256").update(secret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update("zcode_api_key", "utf-8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const stored = [
      "enc:v1:",
      iv.toString("base64url"),
      ".",
      authTag.toString("base64url"),
      ".",
      encrypted.toString("base64url"),
    ].join("");

    expect(decryptCredential(stored, { ZCODE_CREDENTIAL_SECRET: secret })).toBe("zcode_api_key");
  });

  it("rejects a value that does not match the machine's key", () => {
    expect(() =>
      decryptCredential("enc:v1:aaaa.bbbb.cccc", { ZCODE_CREDENTIAL_SECRET: "a-secret" }),
    ).toThrow(/invalid IV|invalid auth tag|does not match/);
  });
});
