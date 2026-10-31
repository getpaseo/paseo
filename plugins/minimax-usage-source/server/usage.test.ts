import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

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

/**
 * Writes the OAuth login the `mcode` CLI keeps under
 * `~/.minimax/auth/<buildEnv>/<region>/<clientId>/`.
 */
function writeMiniMaxOAuthLogin(
  dir: string,
  options: {
    buildEnv?: string;
    region?: string;
    clientId?: string;
    accessToken?: string;
    expiresAtMs?: number;
  } = {},
): string {
  const buildEnv = options.buildEnv ?? "prod";
  const region = options.region ?? "cn";
  const clientId = options.clientId ?? "mcode-public";
  const clientDir = join(dir, ".minimax", "auth", buildEnv, region, clientId);
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, "auth.json"),
    JSON.stringify({
      schemaVersion: 1,
      records: {
        "com.minimax.mcode.oauth.prod.cn": {
          schemaVersion: 1,
          accessToken: options.accessToken ?? "mmoat_fixture_token",
          refreshToken: "mmort_fixture_token",
          tokenType: "Bearer",
          clientId,
          scopes: ["agent.default"],
          audience: "agent-backend",
          ...(options.expiresAtMs === undefined ? {} : { expiresAtMs: options.expiresAtMs }),
        },
      },
    }),
  );
  writeFileSync(
    join(clientDir, "auth-state.json"),
    JSON.stringify({
      schemaVersion: 2,
      status: "authenticated",
      storeKind: "file",
      clientId,
      scopes: ["agent.default"],
      audience: "agent-backend",
      buildEnv,
      region,
      ...(options.expiresAtMs === undefined ? {} : { expiresAtMs: options.expiresAtMs }),
    }),
  );
  return join(clientDir, "auth.json");
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

describe("minimax usage source", () => {
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
              providerId: "minimax",
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

    expect(requestedUrl).toBe("https://api.minimax.io/v1/api/openplatform/coding_plan/remains");
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

  it("omits MiniMax when no credentials are configured", async () => {
    expect(await discover()).toEqual([]);
  });

  it("discovers the OAuth login the mcode CLI stores under ~/.minimax/auth", async () => {
    const authPath = writeMiniMaxOAuthLogin(homeDir, {
      accessToken: "mmoat_fixture_token",
    });

    const accounts = await discover();

    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.input).toEqual({
      store: "oauth",
      locator: authPath,
      baseUrl: "https://api.minimaxi.com",
    });
  });

  it("uses the region host the CLI logged in against", async () => {
    writeMiniMaxOAuthLogin(homeDir, { region: "en" });

    const accounts = await discover();

    expect(accounts[0]?.input).toMatchObject({ baseUrl: "https://api.minimax.io" });
  });

  it("fetches MiniMax usage from the CLI OAuth login", async () => {
    writeMiniMaxOAuthLogin(homeDir, { accessToken: "mmoat_fixture_token" });
    let requestedUrl: string | null = null;
    let authorization: string | null = null;
    fetchApi = (async (url: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = url.toString();
      authorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return jsonResponse({
        model_remains: [
          {
            model_name: "general",
            end_time: Date.parse("2026-06-19T05:00:00.000Z"),
            weekly_end_time: Date.parse("2026-06-26T00:00:00.000Z"),
            current_interval_remaining_percent: 87,
            current_weekly_remaining_percent: 78,
          },
        ],
      });
    }) as unknown as typeof fetch;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(requestedUrl).toBe("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
    expect(authorization).toBe("Bearer mmoat_fixture_token");
    expect(miniMax).toMatchObject({
      status: "available",
      windows: expect.arrayContaining([
        expect.objectContaining({ id: "interval_general", usedPct: 13, remainingPct: 87 }),
        expect.objectContaining({ id: "weekly_general", usedPct: 22, remainingPct: 78 }),
      ]),
    });
  });

  it("reports an expired CLI OAuth login as expired", async () => {
    writeMiniMaxOAuthLogin(homeDir, {
      accessToken: "mmoat_fixture_token",
      expiresAtMs: Date.now() - 60_000,
    });
    let requested = false;
    fetchApi = (async () => {
      requested = true;
      return jsonResponse({ model_remains: [] });
    }) as unknown as typeof fetch;

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(requested).toBe(false);
    expect(miniMax).toMatchObject({
      status: "unavailable",
      problem: { kind: "expired" },
    });
  });

  it("ignores a CLI auth directory that has no access token", async () => {
    writeMiniMaxOAuthLogin(homeDir, { accessToken: "" });

    expect(await discover()).toEqual([]);
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

    expect(requestedUrl).toBe(
      "https://account.example.com/v1/api/openplatform/coding_plan/remains",
    );
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

    expect(requestedUrl).toBe("https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains");
    expect(miniMax.status).toBe("unavailable");
  });

  it("reports MiniMax accounts with no active token plan as unavailable", async () => {
    writeMiniMaxConfig(homeDir, { api_key: "minimax_config_key", region: "cn" });
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
          () =>
            jsonResponse({
              model_remains: null,
              base_resp: { status_code: 2062, status_msg: "no active token plan subscription" },
            }),
        ],
      ]),
    );

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(miniMax).toMatchObject({
      status: "unavailable",
      problem: { kind: "no_quota" },
      error: null,
    });
  });

  it("reports a null MiniMax token plan as unavailable even without base_resp", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
          () => jsonResponse({ model_remains: null }),
        ],
      ]),
    );

    const miniMax = findProvider(await service().listUsage(), "minimax");

    expect(miniMax).toMatchObject({
      status: "unavailable",
      problem: { kind: "no_quota" },
      error: null,
    });
  });

  it("still reads MiniMax windows when base_resp reports success", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
          () =>
            jsonResponse({
              base_resp: { status_code: 0, status_msg: "success" },
              model_remains: [
                {
                  model_name: "MiniMax-M2.7",
                  end_time: Date.parse("2026-06-19T05:00:00.000Z"),
                  current_interval_total_count: 100,
                  current_interval_usage_count: 25,
                  current_interval_remaining_percent: 75,
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
        expect.objectContaining({ id: "interval_MiniMax-M2.7", usedPct: 25 }),
      ]),
    });
  });

  it("marks exhausted MiniMax interval windows with a danger tone", async () => {
    process.env["MINIMAX_API_KEY"] = "minimax_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
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

it("discovery returns a locator when fetch finds minimax credentials", async () => {
  const previous = process.env["MINIMAX_API_KEY"];
  try {
    process.env["MINIMAX_API_KEY"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover()).toEqual([
      { key: "default", input: { store: "env", locator: "MINIMAX_API_KEY" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env["MINIMAX_API_KEY"];
    else process.env["MINIMAX_API_KEY"] = previous;
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
  const previous = process.env["MINIMAX_API_KEY"];
  try {
    process.env["MINIMAX_API_KEY"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "MINIMAX_API_KEY" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["MINIMAX_API_KEY"];
    else process.env["MINIMAX_API_KEY"] = previous;
  }
});
