import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage, parseModelAliases, scopeShowsDeepSeek } from "./usage.js";

const providerSnapshot = {
  kind: "global" as const,
  providers: [
    {
      provider: "pi",
      models: [
        {
          id: "deepseek/deepseek-flash",
          label: "DeepSeek V4.1 Flash",
          description: "DeepSeek",
        },
      ],
    },
    {
      provider: "deepseek-harness-native",
      models: [
        {
          id: "deepseek-official/deepseek-flash",
          label: "DeepSeek-V4.1-Flash",
          description: "DeepSeek",
        },
      ],
    },
  ],
};

describe("DeepSeek usage discovery", () => {
  let home: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "deepseek-usage-"));
    previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      PASEO_DEEPSEEK_MODEL_ALIASES: process.env.PASEO_DEEPSEEK_MODEL_ALIASES,
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.PASEO_DEEPSEEK_MODEL_ALIASES;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("returns no account when no provider exposes DeepSeek", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    expect(
      await discover({
        kind: "global",
        providers: [{ provider: "claude", models: [{ id: "claude-sonnet-5", label: "Sonnet 5" }] }],
      }),
    ).toEqual([]);
  });

  it("deduplicates multiple DeepSeek providers into one balance account", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const accounts = await discover(providerSnapshot);
    expect(accounts).toEqual([
      {
        key: "default",
        label: "DeepSeek API",
        input: { store: "env", locator: "DEEPSEEK_API_KEY" },
      },
    ]);
  });

  it("supports an explicit Claude model alias for opaque proxies", () => {
    process.env.PASEO_DEEPSEEK_MODEL_ALIASES = "claude:claude-sonnet-5;claude:claude-opus-5";
    expect(
      scopeShowsDeepSeek({
        kind: "global",
        providers: [
          {
            provider: "claude",
            models: [{ id: "claude-sonnet-5", label: "Sonnet 5" }],
          },
        ],
      }),
    ).toBe(true);
  });

  it("supports a provider-wide explicit alias", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    process.env.PASEO_DEEPSEEK_MODEL_ALIASES = "claude:*";
    expect(
      await discover({
        kind: "global",
        providers: [
          {
            provider: "claude",
            models: [{ id: "claude-opus-5", label: "Opus 5" }],
          },
        ],
      }),
    ).toHaveLength(1);
  });

  it("uses the Pi DeepSeek key when the environment key is absent", async () => {
    mkdirSync(join(home, ".pi", "agent"), { recursive: true });
    writeFileSync(
      join(home, ".pi", "agent", "auth.json"),
      JSON.stringify({ deepseek: { key: "pi-key" } }),
    );
    expect(await discover(providerSnapshot)).toEqual([
      {
        key: "default",
        label: "DeepSeek API",
        input: { store: "file", locator: join(home, ".pi", "agent", "auth.json") },
      },
    ]);
  });

  it("parses comma and semicolon separated aliases", () => {
    expect(parseModelAliases("claude:sonnet, pi:deepseek-flash;claude:opus")).toEqual([
      { provider: "claude", model: "sonnet" },
      { provider: "pi", model: "deepseek-flash" },
      { provider: "claude", model: "opus" },
    ]);
  });
});

describe("DeepSeek balance", () => {
  let home: string;
  let previous: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "deepseek-balance-"));
    previous = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
    };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("returns one CNY balance report with currency details", async () => {
    const report = await fetchUsage({ store: "env", locator: "DEEPSEEK_API_KEY" }, async () =>
      Response.json({
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "91.48",
            granted_balance: "0.00",
            topped_up_balance: "91.48",
          },
        ],
      }),
    );

    expect(report).toEqual({
      status: "available",
      planLabel: "API balance",
      windows: [],
      balances: [],
      details: [
        { id: "cny_total", label: "CNY total", value: "¥91.48" },
        { id: "cny_topped_up", label: "CNY topped up", value: "¥91.48" },
        { id: "cny_granted", label: "CNY granted", value: "¥0.00" },
      ],
    });
  });

  it("maps USD total balance to the shared USD balance bar", async () => {
    const report = await fetchUsage({ store: "env", locator: "DEEPSEEK_API_KEY" }, async () =>
      Response.json({
        is_available: true,
        balance_infos: [
          {
            currency: "USD",
            total_balance: "12.50",
            granted_balance: "2.50",
            topped_up_balance: "10.00",
          },
        ],
      }),
    );

    expect(report).toMatchObject({
      status: "available",
      balances: [{ id: "usd_balance", label: "USD balance", remaining: 12.5, unit: "usd" }],
    });
  });

  it("reports an insufficient balance as unavailable", async () => {
    const report = await fetchUsage({ store: "env", locator: "DEEPSEEK_API_KEY" }, async () =>
      Response.json({ is_available: false, balance_infos: [] }),
    );
    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "no_quota", detail: "DeepSeek balance is insufficient" },
    });
  });

  it("reports rejected credentials", async () => {
    const report = await fetchUsage(
      { store: "env", locator: "DEEPSEEK_API_KEY" },
      async () => new Response(null, { status: 401 }),
    );
    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401 },
    });
  });
});
