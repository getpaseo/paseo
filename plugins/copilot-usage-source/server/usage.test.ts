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

describe("copilot usage source", () => {
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
              providerId: "copilot",
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
});

it("discovery returns a locator when fetch finds copilot credentials", async () => {
  const previous = process.env["COPILOT_TOKEN"];
  try {
    process.env["COPILOT_TOKEN"] = "fixture-token";
    let requested = false;
    await fetchFirst(async () => {
      requested = true;
      return new Response(null, { status: 401 });
    });
    expect(requested).toBe(true);
    expect(await discover()).toEqual([
      { key: "default", input: { store: "env", locator: "COPILOT_TOKEN" } },
    ]);
  } finally {
    if (previous === undefined) delete process.env["COPILOT_TOKEN"];
    else process.env["COPILOT_TOKEN"] = previous;
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
  const previous = process.env["COPILOT_TOKEN"];
  try {
    process.env["COPILOT_TOKEN"] = "fixture-rejected-login";
    const report = await fetchUsage(
      { store: "env", locator: "COPILOT_TOKEN" },
      async () => new Response(null, { status }),
    );
    expect(report).toEqual({ status: "unavailable", problem: { kind: "rejected", status } });
  } finally {
    if (previous === undefined) delete process.env["COPILOT_TOKEN"];
    else process.env["COPILOT_TOKEN"] = previous;
  }
});

it.each([
  { remaining: 1500, percentRemaining: 100, usedPct: 0 },
  { remaining: 1125, percentRemaining: 75, usedPct: 25 },
  { remaining: 0, percentRemaining: 0, usedPct: 100 },
])(
  "reports premium quota with $remaining requests remaining",
  async ({ remaining, percentRemaining, usedPct }) => {
    const report = await fetchPremiumQuota({
      entitlement: 1500,
      remaining,
      percent_remaining: percentRemaining,
      unlimited: false,
    });
    expect(report).toMatchObject({
      status: "available",
      planLabel: "individual",
      windows: [
        {
          id: "premium_interactions",
          label: "Premium requests",
          usedPct,
          remainingPct: percentRemaining,
          resetsAt: "2026-12-01T00:00:00.000Z",
        },
      ],
      details: expect.arrayContaining([
        {
          id: "premium_remaining",
          label: "Premium requests remaining",
          value: `${remaining} / 1500`,
        },
      ]),
    });
  },
);

it.each([
  undefined,
  null,
  { unlimited: true, percent_remaining: 100, remaining: 1500, entitlement: 1500 },
])(
  "does not invent a finite quota for absent or unlimited premium snapshots (%j)",
  async (premium) => {
    const report = await fetchPremiumQuota(premium);
    expect(report).toMatchObject({
      status: "available",
      windows: [],
      details: [{ id: "reset", label: "Quota reset", value: "2026-12-01" }],
    });
  },
);

it("reports a percentage without inventing missing counts and falls back to the legacy reset", async () => {
  const report = await fetchPremiumQuota({ percent_remaining: 60, unlimited: false }, null);
  expect(report).toMatchObject({
    status: "available",
    windows: [{ usedPct: 40, remainingPct: 60, resetsAt: "2026-12-01" }],
    details: [{ id: "reset", label: "Quota reset", value: "2026-12-01" }],
  });
});

async function fetchPremiumQuota(
  premium: unknown,
  utcReset: string | null = "2026-12-01T00:00:00.000Z",
) {
  const { writeFile } = await import("node:fs/promises");
  const directory = mkdtempSync(join(tmpdir(), "copilot-premium-"));
  const locator = join(directory, "hosts.yml");
  try {
    await writeFile(locator, "github.com:\n  oauth_token: fixture-copilot\n");
    return await fetchUsage({ store: "file", locator }, async () =>
      jsonResponse({
        copilot_plan: "individual",
        quota_reset_date: "2026-12-01",
        quota_reset_date_utc: utcReset,
        quota_snapshots: {
          premium_interactions: premium,
          chat: { unlimited: true, percent_remaining: 100 },
          completions: { unlimited: true, percent_remaining: 100 },
        },
      }),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
