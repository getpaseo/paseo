import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";
import type { UsageReport } from "@getpaseo/plugin/server/usage";

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

describe("zai usage source", () => {
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
              providerId: "zai",
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
        [
          "https://api.z.ai/api/monitor/usage/quota/limit",
          () =>
            jsonResponse({
              success: true,
              data: {
                level: "max",
                limits: [
                  { type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 12 },
                  {
                    type: "CREDIT_LIMIT",
                    unit: 6,
                    number: 1,
                    percentage: 100,
                    nextResetTime: 1_790_286_270_984,
                  },
                ],
              },
            }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    expect(zai).toMatchObject({
      status: "available",
      planLabel: "GLM Coding Max",
      // Subscription's raw start/end date range and purchase timestamp are deliberately
      // not surfaced: they duplicate/conflict with the quota windows' own resetsAt values.
      details: [{ id: "status", label: "Status", value: "VALID" }],
      windows: [
        {
          id: "five_hour",
          label: "5-hour",
          shortLabel: "5h",
          summary: true,
          usedPct: 12,
          remainingPct: 88,
          resetsAt: null,
          tone: "ok",
        },
        {
          id: "weekly",
          label: "Weekly",
          shortLabel: "wk",
          summary: true,
          usedPct: 100,
          remainingPct: 0,
          resetsAt: new Date(1_790_286_270_984).toISOString(),
          tone: "danger",
        },
      ],
    });
  });

  it("falls back to the quota-limit plan tier when subscription/list has no product name", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        ["https://api.z.ai/api/biz/subscription/list", () => jsonResponse({}, 404)],
        [
          "https://api.z.ai/api/monitor/usage/quota/limit",
          () => jsonResponse({ success: true, data: { level: "lite", limits: [] } }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    expect(zai).toMatchObject({ status: "available", planLabel: "Lite", windows: [] });
  });

  it("keeps Z.ai quota windows when the subscription request fails at the network", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.z.ai/api/biz/subscription/list",
          () => {
            // undici's shape for a connection-level failure.
            throw new TypeError("fetch failed");
          },
        ],
        [
          "https://api.z.ai/api/monitor/usage/quota/limit",
          () =>
            jsonResponse({
              success: true,
              data: {
                level: "pro",
                limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 40 }],
              },
            }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    expect(zai).toMatchObject({
      status: "available",
      planLabel: "Pro",
      error: null,
      windows: [expect.objectContaining({ id: "five_hour", label: "5-hour", usedPct: 40 })],
    });
  });

  it.each([
    ["a schema mismatch", () => jsonResponse({ data: "nope" })],
    ["a non-JSON body", () => new Response("<html>gateway</html>", { status: 200 })],
  ])("keeps Z.ai quota windows when the subscription response is %s", async (_case, response) => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        ["https://api.z.ai/api/biz/subscription/list", response],
        [
          "https://api.z.ai/api/monitor/usage/quota/limit",
          () =>
            jsonResponse({
              success: true,
              data: {
                level: "pro",
                limits: [{ type: "CREDIT_LIMIT", unit: 3, number: 5, percentage: 30 }],
              },
            }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    expect(zai).toMatchObject({
      status: "available",
      planLabel: "Pro",
      details: [],
      windows: [expect.objectContaining({ id: "five_hour", usedPct: 30 })],
    });
  });

  it("surfaces a failed Z.ai quota request even though subscription succeeds", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        [
          "https://api.z.ai/api/biz/subscription/list",
          () => jsonResponse({ data: [{ productName: "GLM Coding Max", status: "VALID" }] }),
        ],
        ["https://api.z.ai/api/monitor/usage/quota/limit", () => jsonResponse({}, 500)],
      ]),
    );

    // A plan label with no bars is an empty card, so a quota-only failure must not
    // render as available.
    await expect(service().listUsage()).rejects.toThrow("Z.ai usage API returned 500");
  });

  it("reports a Z.ai HTTP 200 authentication failure envelope as a rejected login", async () => {
    process.env["ZAI_API_KEY"] = "zai_bad_token";
    const rejected = () =>
      jsonResponse({ code: 1000, msg: "Authentication Failed", success: false });
    fetchApi = mockFetch(
      new Map([
        ["https://api.z.ai/api/biz/subscription/list", rejected],
        ["https://api.z.ai/api/monitor/usage/quota/limit", rejected],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");

    // HTTP 200 carries no auth status, so the problem reports the 401 the code means.
    expect(zai).toMatchObject({
      status: "unavailable",
      problem: { kind: "rejected", status: 401 },
    });
  });

  it("surfaces any other Z.ai HTTP 200 failure envelope as an error", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        ["https://api.z.ai/api/biz/subscription/list", () => jsonResponse({ data: [] })],
        [
          "https://api.z.ai/api/monitor/usage/quota/limit",
          () => jsonResponse({ code: 500, msg: "System busy", success: false }),
        ],
      ]),
    );

    await expect(service().listUsage()).rejects.toThrow("System busy");
  });

  it("scopes Z.ai request limits and keeps their window ids unique", async () => {
    process.env["ZAI_API_KEY"] = "zai_test_token";
    fetchApi = mockFetch(
      new Map([
        ["https://api.z.ai/api/biz/subscription/list", () => jsonResponse({ data: [] })],
        [
          "https://api.z.ai/api/monitor/usage/quota/limit",
          () =>
            jsonResponse({
              success: true,
              data: {
                limits: [
                  { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 20 },
                  { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10 },
                  { type: "TIME_LIMIT", unit: 5, number: 1, percentage: 0, nextResetTime: null },
                ],
              },
            }),
        ],
      ]),
    );

    const zai = findProvider(await service().listUsage(), "zai");
    if (zai.status !== "available") throw new Error(`Expected available, got ${zai.status}`);

    expect(zai.windows.map((window) => window.id)).toEqual([
      "five_hour",
      "requests:monthly",
      "requests:monthly_2",
    ]);
    expect(zai.windows[1]).toMatchObject({
      label: "Requests · Monthly",
      shortLabel: "Requests mo",
    });
    // A request limit is not the coding quota, so it stays out of the usage summary.
    expect(zai.windows[1]).not.toHaveProperty("summary");
    expect(zai.windows[2]).toMatchObject({ usedPct: 0, resetsAt: null });
  });
});

it("discovery returns a locator when fetch finds zai credentials", async () => {
  const previous = process.env["ZAI_API_KEY"];
  try {
    process.env["ZAI_API_KEY"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover()).toEqual([
      { key: "default", input: { store: "env", locator: "ZAI_API_KEY" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env["ZAI_API_KEY"];
    else process.env["ZAI_API_KEY"] = previous;
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
  const previous = process.env["ZAI_API_KEY"];
  try {
    process.env["ZAI_API_KEY"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "ZAI_API_KEY" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["ZAI_API_KEY"];
    else process.env["ZAI_API_KEY"] = previous;
  }
});
