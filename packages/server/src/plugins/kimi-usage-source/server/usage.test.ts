import { mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

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

describe("kimi usage source", () => {
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
              providerId: "kimi",
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

  it("returns unavailable on 401 without refreshing or rewriting the credential file", async () => {
    writeKimiCredentials(join(homeDir, ".kimi-code"), "at_kimi_expired");
    const credPath = kimiCredentialPath(join(homeDir, ".kimi-code"));
    const before = readFileSync(credPath, "utf8");
    let usageCalls = 0;
    fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.kimi.com/coding/v1/usages") {
        usageCalls += 1;
        return new Response(null, { status: 401 });
      }
      // The read-only fetcher must never hit the OAuth token endpoint.
      throw new Error(`Unmocked: ${endpoint}`);
    }) as never;

    const result = await service({ kimiHomeDir: homeDir }).listUsage();

    expect(findProvider(result, "kimi").status).toBe("unavailable");
    expect(usageCalls).toBe(1);
    // The credentials file must be left untouched for the Kimi CLI to own.
    expect(readFileSync(credPath, "utf8")).toBe(before);
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
});

describe("Kimi usage source usage windows", () => {
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
    const usage = await fetchUsage({}, fetchApi);

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
    const usage = await fetchUsage({}, fetchApi);

    expect(usage.windows).toHaveLength(2);
    expect(usage.windows[1]).toMatchObject({
      label: "5-hour limit",
      usedPct: 50,
      remainingPct: 50,
    });
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
    const usage = await fetchUsage({}, fetchApi);

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
    const usage = await fetchUsage({}, fetchApi);

    expect(usage.windows.map((window) => window.id)).toEqual([
      "coding_limit_300_time_unit_minute",
      "coding_limit_300_time_unit_minute_2",
    ]);
  });
});
