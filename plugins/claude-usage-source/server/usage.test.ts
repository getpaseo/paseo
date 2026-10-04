import { isDeepStrictEqual } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchUsage, discover } from "./usage.js";
import { inputSchema, type UsageInput } from "../shared/input.js";
import { hashAccountKey, type UsageReport } from "@getpaseo/plugin/server/usage";

function credentialInput(directory: string): UsageInput {
  return { route: { store: "claude", path: join(directory, ".credentials.json") } };
}

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

describe("claude usage source", () => {
  let claudeHome: string;
  let homeDir: string;
  let fetchApi: typeof fetch;
  let originalEnv: Record<string, string | undefined>;
  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "usage-claude-"));
    homeDir = mkdtempSync(join(tmpdir(), "usage-home-"));
    originalEnv = { ...process.env };
    process.env["HOME"] = homeDir;
    process.env["USERPROFILE"] = homeDir;
    process.env["CLAUDE_CONFIG_DIR"] = claudeHome;
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
    rmSync(claudeHome, { recursive: true, force: true });
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
        const report = await fetchUsage(credentialInput(claudeHome), (url, init) =>
          fetchApi(url, init),
        );
        return {
          providers: [
            {
              providerId: "claude",
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

  it.each(["empty home", "unrelated files"])(
    "discovers no Claude logins in %s",
    async (scenario) => {
      if (scenario === "unrelated files") writeFileSync(join(homeDir, "unrelated.json"), "{}");
      expect(
        await discover({ kind: "global" }, { home: homeDir, env: {}, platform: "linux" }),
      ).toEqual([]);
    },
  );

  it("returns unavailable on 401 without refreshing or rewriting credentials", async () => {
    writeClaudeCredentials(claudeHome, "at_expired", "rt_valid");
    const credPath = join(claudeHome, ".credentials.json");
    const before = readFileSync(credPath, "utf8");
    let usageCalls = 0;
    fetchApi = vi.fn(async (url: RequestInfo | URL) => {
      const endpoint = url.toString();
      if (endpoint === "https://api.anthropic.com/api/oauth/usage") {
        usageCalls += 1;
        return new Response(null, { status: 401 });
      }
      // The read-only fetcher must never hit the OAuth token endpoint.
      throw new Error(`Unmocked: ${endpoint}`);
    }) as never;

    const result = await service().listUsage();

    expect(findProvider(result, "claude").status).toBe("unavailable");
    expect(usageCalls).toBe(1);
    // The credentials file must be left untouched for the Claude CLI to own.
    expect(readFileSync(credPath, "utf8")).toBe(before);
  });
});

describe("usage bars escalate as they fill", () => {
  let claudeHome: string;

  beforeEach(() => {
    claudeHome = mkdtempSync(join(tmpdir(), "paseo-tone-claude-"));
  });

  afterEach(() => {
    rmSync(claudeHome, { recursive: true, force: true });
  });

  function claudeAt(utilization: number) {
    writeClaudeCredentials(claudeHome, "at_valid");
    process.env["CLAUDE_CONFIG_DIR"] = claudeHome;
    return fetchUsage(
      credentialInput(claudeHome),
      mockFetch(
        new Map([
          [
            "https://api.anthropic.com/api/oauth/usage",
            () => jsonResponse({ seven_day: { utilization, resets_at: "2026-06-04T00:00:00Z" } }),
          ],
        ]),
      ),
    );
  }

  it.each([
    [10, "ok"],
    [75, "warning"],
    [99, "danger"],
  ])("a Claude window at %s%% is %s", async (utilization, tone) => {
    const usage = await claudeAt(utilization);
    expect(usage.windows).toEqual([expect.objectContaining({ id: "weekly", tone })]);
  });
});

describe("Claude usage source scoped weekly limits", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
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
    process.env["CLAUDE_CONFIG_DIR"] = claudeHome;
    const fetchApi = mockFetch(
      new Map([["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(body)]]),
    );
    return { provider: { fetchUsage: () => fetchUsage(credentialInput(claudeHome), fetchApi) } };
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

  it("summarizes the session and weekly windows by default, not scoped ones", async () => {
    const { provider } = claudeProvider({
      five_hour: { utilization: 6, resets_at: "2026-06-01T21:00:00Z" },
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [fableLimit()],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => [window.id, window.summary ?? false])).toEqual([
      ["five_hour", true],
      ["weekly", true],
      ["weekly_model_fable", false],
    ]);
  });

  it("gives every window a short label for tight spaces", async () => {
    const { provider } = claudeProvider({
      five_hour: { utilization: 6, resets_at: "2026-06-01T21:00:00Z" },
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [fableLimit()],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => [window.id, window.shortLabel])).toEqual([
      ["five_hour", "5h"],
      ["weekly", "wk"],
      ["weekly_model_fable", "wk Fable"],
    ]);
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
    const { provider } = claudeProvider({
      seven_day: { utilization: 23, resets_at: "2026-06-04T00:00:00Z" },
      limits: [fableLimit({ scope: { model: { id: null, display_name: null }, surface: null } })],
    });

    const usage = await provider.fetchUsage();

    expect(usage.windows.map((window) => window.id)).toEqual(["weekly"]);
    expect(console.warn).toHaveBeenCalled();
  });

  // Regression: an additive section must never take down data that already parsed.
  it("keeps the top-level windows when a limits entry is malformed", async () => {
    const { provider } = claudeProvider({
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
    expect(console.warn).toHaveBeenCalled();
  });

  it("warns when a successful response describes no windows at all", async () => {
    const { provider } = claudeProvider({ limits: [] });

    const usage = await provider.fetchUsage();

    expect(usage.windows).toEqual([]);
    expect(console.warn).toHaveBeenCalledWith(
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

describe("Claude usage source scoped limit reconciliation", () => {
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
    process.env["CLAUDE_CONFIG_DIR"] = claudeHome;
    const usage = await fetchUsage(
      credentialInput(claudeHome),
      mockFetch(new Map([["https://api.anthropic.com/api/oauth/usage", () => jsonResponse(body)]])),
    );
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

it("discovery uses the credential token profile instead of stale Claude config", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "claude-identity-"));
  try {
    await writeFile(
      join(directory, ".claude.json"),
      JSON.stringify({
        oauthAccount: {
          accountUuid: "account-uuid",
          organizationUuid: "org-uuid",
          emailAddress: "test@example.com",
        },
      }),
    );
    writeClaudeCredentials(directory, "fixture-local-account");
    expect(
      await accountFor(
        credentialInput(directory),
        async () =>
          jsonResponse({
            account: { uuid: "token-account", email: "token@example.test" },
            organization: { uuid: "token-org" },
          }),
        Date.now,
        { home: directory, claudeHome: directory },
      ),
    ).toEqual({
      key: "token-account.token-org",
      label: "token@example.test",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("Claude credentials without account metadata use a cached OAuth profile identity", async () => {
  let calls = 0;
  const fetchProfile: typeof fetch = async () => {
    calls++;
    return new Response(
      JSON.stringify({
        account: { uuid: "account-uuid", email: "test@example.com" },
        organization: { uuid: "org-uuid" },
      }),
      { status: 200 },
    );
  };
  const lookup = tokenLookup("fixture-claude-token");
  expect(
    await accountFor(credentialInput(lookup.claudeHome), fetchProfile, Date.now, lookup),
  ).toEqual({
    key: "account-uuid.org-uuid",
    label: "test@example.com",
  });
  expect(
    await accountFor(credentialInput(lookup.claudeHome), fetchProfile, Date.now, lookup),
  ).toEqual({
    key: "account-uuid.org-uuid",
    label: "test@example.com",
  });
  expect(calls).toBe(1);
});

it("identifies the same credential route that fetch uses when oauthAccount is absent", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-credential-identity-"));
  try {
    writeClaudeCredentials(directory, "fixture-credential-token");
    writeFileSync(join(directory, ".claude.json"), JSON.stringify({}));
    let usageRequested = false;
    await fetchUsage(
      credentialInput(directory),
      async () => {
        usageRequested = true;
        return new Response(null, { status: 401 });
      },
      { claudeHome: directory },
    );
    expect(usageRequested).toBe(true);
    let profileRequested = false;
    const account = await accountFor(
      credentialInput(directory),
      async () => {
        profileRequested = true;
        return jsonResponse({
          account: { uuid: "account-uuid", email: "owner@example.test" },
          organization: { uuid: "org-uuid" },
        });
      },
      Date.now,
      { claudeHome: directory, home: directory },
    );
    expect(profileRequested).toBe(true);
    expect(account).toEqual({ key: "account-uuid.org-uuid", label: "owner@example.test" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("expires cached token profiles after five minutes", async () => {
  let now = 0;
  let calls = 0;
  const fetchProfile: typeof fetch = async () => {
    calls++;
    return jsonResponse({ account: { uuid: "account-uuid" }, organization: { uuid: "org-uuid" } });
  };
  const lookup = tokenLookup("ttl-fixture-token");
  const input = credentialInput(lookup.claudeHome);
  await accountFor(input, fetchProfile, () => now, lookup);
  await accountFor(input, fetchProfile, () => now, lookup);
  expect(calls).toBe(1);
  now = 300_001;
  await accountFor(input, fetchProfile, () => now, lookup);
  expect(calls).toBe(2);
});

it("discovery and fetch share the explicit macOS keychain route", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-keychain-identity-"));
  try {
    const lookup = {
      platform: "darwin" as const,
      env: { USER: "fixture", CLAUDE_CONFIG_DIR: directory },
      claudeHome: directory,
      home: directory,
      readKeychainCredentials: async () => ({
        claudeAiOauth: { accessToken: "keychain-fixture-token" },
      }),
    };
    let usageRequested = false;
    await fetchUsage(
      {
        route: {
          store: "keychain",
          account: "fixture",
          service: `Claude Code-credentials-${hashAccountKey(directory).slice(0, 8)}`,
        },
      },
      async () => {
        usageRequested = true;
        return new Response(null, { status: 401 });
      },
      lookup,
    );
    expect(usageRequested).toBe(true);
    const account = await accountFor(
      {
        route: {
          store: "keychain",
          account: "fixture",
          service: `Claude Code-credentials-${hashAccountKey(directory).slice(0, 8)}`,
        },
      },
      async () =>
        jsonResponse({
          account: { uuid: "keychain-account" },
          organization: { uuid: "keychain-org" },
        }),
      Date.now,
      lookup,
    );
    expect(account).toEqual({ key: "keychain-account.keychain-org" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("discovery and fetch share the explicit Claude credential route", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-home-identity-"));
  try {
    writeClaudeCredentials(directory, "home-fixture-token");
    const lookup = { claudeHome: directory, home: directory };
    let usageRequested = false;
    await fetchUsage(
      credentialInput(directory),
      async () => {
        usageRequested = true;
        return new Response(null, { status: 401 });
      },
      lookup,
    );
    expect(usageRequested).toBe(true);
    const identity = await accountFor(
      credentialInput(directory),
      async () =>
        jsonResponse({
          account: { uuid: "home-account" },
          organization: { uuid: "home-org" },
        }),
      Date.now,
      lookup,
    );
    expect(identity).toEqual({ key: "home-account.home-org" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("bounds cached profiles across many token rotations", async () => {
  let calls = 0;
  const fetchProfile: typeof fetch = async () => {
    calls++;
    return jsonResponse({ account: { uuid: "account" }, organization: { uuid: "org" } });
  };
  for (let index = 0; index < 129; index++) {
    const lookup = tokenLookup(`rotation-fixture-${index}`);
    await accountFor(credentialInput(lookup.claudeHome), fetchProfile, Date.now, lookup);
  }
  const lookup = tokenLookup("rotation-fixture-0");
  await accountFor(credentialInput(lookup.claudeHome), fetchProfile, Date.now, lookup);
  expect(calls).toBe(130);
});

it("discovery input requires a route and rejects raw credentials", () => {
  expect(inputSchema.safeParse({ accessToken: "unused" }).success).toBe(false);
  expect(inputSchema.safeParse({ configDir: "/unused" }).success).toBe(false);
  expect(() => inputSchema.parse({})).toThrow();
});

const tokenDirectories: string[] = [];
afterEach(() => {
  for (const directory of tokenDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function tokenLookup(accessToken: string) {
  const directory = mkdtempSync(join(tmpdir(), "claude-profile-token-"));
  tokenDirectories.push(directory);
  writeClaudeCredentials(directory, accessToken);
  return { claudeHome: directory, home: directory };
}

it("discovers a Pi OAuth login independently of the CLI login", async () => {
  const { mkdir, mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "usage-pi-discovery-"));
  try {
    await mkdir(join(directory, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(directory, ".pi", "agent", "auth.json"),
      JSON.stringify({
        anthropic: { type: "oauth", access: "fixture-pi", accountId: "pi-account" },
      }),
    );
    const inputs = await discover(
      { kind: "global" },
      { home: directory, env: {}, platform: "linux" },
    );
    expect(inputs.map((account) => account.input)).toContainEqual({
      route: { store: "pi", path: join(directory, ".pi", "agent", "auth.json") },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("keeps an expired Keychain login without calling the network and prefers Keychain over the fallback file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "claude-expired-"));
  try {
    writeClaudeCredentials(directory, "stale-file");
    const lookup = {
      home: directory,
      claudeHome: directory,
      env: { USER: "fixture" },
      platform: "darwin" as const,
      now: () => 10_800_000,
      readKeychainCredentials: async () => ({
        claudeAiOauth: { accessToken: "expired-keychain", expiresAt: 0 },
      }),
    };
    let calls = 0;
    const network: typeof fetch = async () => {
      calls++;
      throw new Error("must not call network");
    };
    const accounts = await discover({ kind: "global" }, lookup, network);
    expect(accounts).toEqual([
      {
        key: expect.stringMatching(/^[a-f0-9]{64}$/),
        input: {
          route: { store: "keychain", service: "Claude Code-credentials", account: "fixture" },
        },
      },
    ]);
    expect(await fetchUsage(accounts[0]!.input as UsageInput, network, lookup)).toEqual({
      status: "unavailable",
      problem: { kind: "expired", expiresAt: "1970-01-01T00:00:00.000Z", refreshedBy: "claude" },
    });
    expect(calls).toBe(0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function accountFor(
  input: UsageInput,
  fetchApi: typeof fetch,
  now: () => number,
  lookup: Parameters<typeof discover>[0] = {},
) {
  const accounts = await discover({ kind: "global" }, { ...lookup, now }, fetchApi);
  const account = accounts.find((candidate) => isDeepStrictEqual(candidate.input, input));
  if (!account) throw new Error("Expected discovered login");
  return { key: account.key, ...(account.label ? { label: account.label } : {}) };
}
it.each([401, 403])("fetch reports rejected usage HTTP %i", async (status) => {
  const lookup = tokenLookup(`usage-rejection-${status}`);
  expect(
    await fetchUsage(
      credentialInput(lookup.claudeHome),
      async () => new Response(null, { status }),
      lookup,
    ),
  ).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status, refreshedBy: "claude" },
  });
});

it.each([401, 403])("a rejected profile HTTP %i keeps a locator-keyed account", async (status) => {
  const lookup = tokenLookup(`profile-rejection-${status}`);
  const api: typeof fetch = async () => new Response(null, { status });
  const accounts = await discover({ kind: "global" }, lookup, api);
  expect(accounts).toEqual([
    { key: expect.stringMatching(/^[a-f0-9]{64}$/), input: credentialInput(lookup.claudeHome) },
  ]);
  let fetches = 0;
  expect(
    await fetchUsage(
      credentialInput(lookup.claudeHome),
      async () => {
        fetches++;
        throw new Error("profile already rejected");
      },
      lookup,
    ),
  ).toEqual({
    status: "unavailable",
    problem: { kind: "rejected", status, refreshedBy: "claude" },
  });
  expect(fetches).toBe(0);
});

it.each([
  { failure: "HTTP 500", networkError: false, error: "Claude usage API returned 500" },
  { failure: "a network error", networkError: true, error: "Network unavailable" },
])(
  "keeps a locator-keyed login when the profile fails with $failure",
  async ({ networkError, error }) => {
    const lookup = tokenLookup(`profile-failure-${networkError}`);
    const input = credentialInput(lookup.claudeHome);
    const api: typeof fetch = async () => {
      if (networkError) throw new Error(error);
      return new Response(null, { status: 500 });
    };
    const accounts = await discover({ kind: "global" }, lookup, api);
    expect(accounts).toEqual([{ key: hashAccountKey(JSON.stringify(input.route)), input }]);
    await expect(fetchUsage(accounts[0]!.input as UsageInput, api, lookup)).rejects.toThrow(error);
  },
);

it("re-reads a refreshed login at the original locator", async () => {
  const lookup = tokenLookup("expiring-token");
  writeFileSync(
    join(lookup.claudeHome, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "expiring-token", expiresAt: 0 } }),
  );
  const [account] = await discover({ kind: "global" }, lookup, async () => {
    throw new Error("expired token must not fetch");
  });
  expect(await fetchUsage(account!.input as UsageInput, fetch, lookup)).toEqual({
    status: "unavailable",
    problem: { kind: "expired", expiresAt: "1970-01-01T00:00:00.000Z", refreshedBy: "claude" },
  });
  writeClaudeCredentials(lookup.claudeHome, "rotated-token");
  const report = await fetchUsage(
    account!.input as UsageInput,
    async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer rotated-token");
      return jsonResponse(makeClaudeResponse());
    },
    lookup,
  );
  expect(report.status).toBe("available");
});

it("session discovery reads only its Claude home and excludes foreign sessions", async () => {
  const home = mkdtempSync(join(tmpdir(), "claude-session-scope-"));
  try {
    writeClaudeCredentials(home, "scoped-unique-token");
    const scope = {
      kind: "session" as const,
      provider: "claude",
      env: { HOME: home, CLAUDE_CONFIG_DIR: home },
    };
    const calls: string[] = [];
    const api: typeof fetch = async (url) => {
      calls.push(String(url));
      return jsonResponse({
        account: { uuid: "session-account", email: "session@example.test" },
        organization: { uuid: "org" },
      });
    };
    const lookup = { platform: "linux" as const, home: "/unused-default-home", env: {} };
    const accounts = await discover(scope, lookup, api);
    expect(accounts).toEqual([
      { key: "session-account.org", label: "session@example.test", input: credentialInput(home) },
    ]);
    await discover(scope, lookup, api);
    expect(calls).toEqual(["https://api.anthropic.com/api/oauth/profile"]);
    for (const env of [
      { CLAUDE_CODE_USE_BEDROCK: "1" },
      { CLAUDE_CODE_USE_VERTEX: "1" },
      { ANTHROPIC_BASE_URL: "https://other.test" },
    ]) {
      expect(await discover({ ...scope, env: { ...scope.env, ...env } }, lookup, api)).toEqual([]);
    }
    expect(await discover({ ...scope, provider: "codex" }, lookup, api)).toEqual([]);
    expect(
      await discover(
        { ...scope, env: { ...scope.env, CLAUDE_CONFIG_DIR: join(home, "missing") } },
        lookup,
        api,
      ),
    ).toEqual([]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it("session Keychain input retains the selected config-directory locator through fetch", async () => {
  const reads: string[] = [];
  const scope = {
    kind: "session" as const,
    provider: "claude",
    env: { HOME: "/fixture", USER: "fixture-user", CLAUDE_CONFIG_DIR: "/fixture/work" },
  };
  const service = `Claude Code-credentials-${hashAccountKey(scope.env.CLAUDE_CONFIG_DIR).slice(0, 8)}`;
  const lookup = {
    platform: "darwin" as const,
    readKeychainCredentials: async (selected: string, account: string) => {
      reads.push(`${selected}:${account}`);
      return { claudeAiOauth: { accessToken: "scoped-keychain-fixture" } };
    },
  };
  const accounts = await discover(scope, lookup, async () =>
    jsonResponse({ account: { uuid: "keychain-scoped" }, organization: { uuid: "org" } }),
  );
  expect(accounts).toHaveLength(1);
  const input = inputSchema.parse(accounts[0]?.input);
  expect(input.route).toEqual({ store: "keychain", service, account: "fixture-user" });
  await fetchUsage(input, async () => jsonResponse(makeClaudeResponse()), {
    ...lookup,
    env: { CLAUDE_CONFIG_DIR: "/somewhere-else" },
  });
  expect(reads).toEqual(Array(3).fill(`${service}:fixture-user`));
});
