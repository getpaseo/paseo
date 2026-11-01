import { describe, expect, test, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderLaunch, ProviderRegistration } from "@getpaseo/plugin/server/provider";
import type { UsageSourceRegistration } from "@getpaseo/plugin/server/usage";
import contribute from "../index.server.js";
import { createAntigravityProvider } from "./provider.js";
import { accountKey, buildSummaryWindows, Usage } from "./usage.js";

const sampleAgyUsageJson = JSON.stringify({
  conversation_id: "",
  status: "SUCCESS",
  response: "Gemini Models\tWeekly Limit Remaining\t98%\t2026-11-01T09:42:13Z\n",
  duration_seconds: 0,
  num_turns: 0,
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  },
  command: {
    name: "usage",
    data: {
      description: "Limits description",
      groups: [
        {
          name: "Gemini Models",
          description: "Models within this group: Gemini Flash, Gemini Pro",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.9785,
              reset_time: "2026-11-01T09:42:13Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.9,
              reset_time: "2026-10-26T02:21:56Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          description: "Models within this group: Claude Opus, Claude Sonnet, GPT-OSS",
          buckets: [
            {
              id: "3p-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 1,
              reset_time: "2026-11-01T21:28:07Z",
            },
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              disabled: true,
              remaining_fraction: 1,
              reset_time: "2026-10-26T02:28:07Z",
            },
          ],
        },
        {
          name: "Gemini 4 Argon",
          description: "Argon quota description",
          buckets: [
            {
              id: "gemini-argon-wtu-weekly",
              name: "Gemini 4 Argon Weekly Limit",
              window: "weekly",
              remaining_fraction: 0,
              reset_time: "2026-10-26T12:48:38Z",
            },
          ],
        },
      ],
    },
  },
});

function antigravityConfigHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "antigravity-usage-"));
  mkdirSync(path.join(home, ".gemini", "antigravity-cli"), { recursive: true });
  return home;
}

describe("Antigravity Usage", () => {
  test("accountKey derives stable hash from launch environment", () => {
    const key1 = accountKey({ HOME: "/home/user1" });
    const key2 = accountKey({ HOME: "/home/user1" });
    const key3 = accountKey({ HOME: "/home/user2" });
    const keyCustom = accountKey({
      HOME: "/home/user1",
      ANTIGRAVITY_HOME: "/custom/gemini/antigravity-cli",
    });

    expect(key1).toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).not.toBe(keyCustom);
    expect(typeof key1).toBe("string");
    expect(key1.length).toBeGreaterThan(0);
  });

  test("buildSummaryWindows maps groups and buckets into UsageWindows", () => {
    const parsed = JSON.parse(sampleAgyUsageJson);
    const windows = buildSummaryWindows(parsed.command.data.groups);

    expect(windows).toHaveLength(5);

    const geminiWeekly = windows.find((w) => w.id === "gemini-weekly");
    expect(geminiWeekly).toBeDefined();
    expect(geminiWeekly).toMatchObject({
      id: "gemini-weekly",
      label: "Gemini · Weekly",
      shortLabel: "Gemini wk",
      summary: true,
      usedPct: 2,
      remainingPct: 98,
      resetsAt: "2026-11-01T09:42:13Z",
      tone: "ok",
    });

    const gemini5h = windows.find((w) => w.id === "gemini-5h");
    expect(gemini5h).toBeDefined();
    expect(gemini5h?.summary).toBeUndefined();
    expect(gemini5h).toMatchObject({
      id: "gemini-5h",
      label: "Gemini · 5h",
      shortLabel: "Gemini 5h",
      usedPct: 10,
      remainingPct: 90,
      resetsAt: "2026-10-26T02:21:56Z",
      tone: "ok",
    });

    const claudeWeekly = windows.find((w) => w.id === "claude-gpt-oss-weekly");
    expect(claudeWeekly).toBeDefined();
    expect(claudeWeekly).toMatchObject({
      id: "claude-gpt-oss-weekly",
      label: "Claude & GPT-OSS · Weekly",
      shortLabel: "Claude/OSS wk",
      summary: true,
      usedPct: 0,
      remainingPct: 100,
      resetsAt: "2026-11-01T21:28:07Z",
      tone: "ok",
    });

    // agy reports the Claude/GPT 5-hour window as disabled on plans it does not apply to; the
    // card must carry that as a placeholder state, not as unused quota.
    const claude5h = windows.find((w) => w.id === "claude-gpt-oss-5h");
    expect(claude5h).toBeDefined();
    expect(claude5h?.summary).toBeUndefined();
    expect(claude5h).toMatchObject({
      id: "claude-gpt-oss-5h",
      label: "Claude & GPT-OSS · 5h · Disabled",
      shortLabel: "Claude/OSS 5h",
      usedPct: null,
      remainingPct: null,
      resetsAt: null,
      tone: "default",
    });

    const argonWeekly = windows.find((w) => w.id === "gemini-argon-weekly");
    expect(argonWeekly).toBeDefined();
    expect(argonWeekly).toMatchObject({
      id: "gemini-argon-weekly",
      label: "Gemini 4 Argon · Weekly",
      shortLabel: "Argon wk",
      summary: true,
      usedPct: 100,
      remainingPct: 0,
      resetsAt: "2026-10-26T12:48:38Z",
      tone: "danger",
    });
  });

  test("Usage registration exposes Antigravity metadata", () => {
    const usage = new Usage();
    const registration = usage.registration();

    expect(registration.id).toBe("antigravity");
    expect(registration.label).toBe("Antigravity");
    expect(registration.icon).toBe("icon.svg");
  });

  test("Usage falls back to a config-directory account in global discovery", async () => {
    const home = antigravityConfigHome();
    try {
      const usage = new Usage(
        async () => sampleAgyUsageJson,
        () => ({ HOME: home }),
      );
      const source = usage.registration();

      const key = accountKey({ HOME: home });
      expect(await source.discover({ kind: "global" })).toEqual([
        { key, label: "Antigravity", input: { account: key } },
      ]);

      // The placeholder launch is fetchable before any provider snapshot has run.
      const report = await source.fetch({ account: key });
      expect(report.status).toBe("available");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Usage replaces the config-directory fallback once the provider launch is remembered", async () => {
    const home = antigravityConfigHome();
    try {
      const usage = new Usage(undefined, () => ({ HOME: home }));
      const source = usage.registration();

      const fallbackKey = accountKey({ HOME: home });
      expect((await source.discover({ kind: "global" })).map((account) => account.key)).toEqual([
        fallbackKey,
      ]);

      const launch: ProviderLaunch = {
        command: "/usr/local/bin/agy",
        args: ["--profile", "work"],
        env: { HOME: "/home/resolved-user" },
      };
      const { account } = usage.remember(launch);
      expect(account).not.toBe(fallbackKey);

      expect(await source.discover({ kind: "global" })).toEqual([
        { key: account, label: "Antigravity", input: { account } },
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Usage stops replacing the fallback key once the same account launch is remembered", async () => {
    const home = antigravityConfigHome();
    try {
      const usage = new Usage(undefined, () => ({ HOME: home }));
      const source = usage.registration();

      // Engage the placeholder discovery, then remember real launches: first for the same
      // default account, then an overridden one. Both real accounts must coexist instead of
      // deleting each other.
      await source.discover({ kind: "global" });
      usage.remember({ command: "/usr/bin/agy", args: [], env: { HOME: home } });
      const override = { HOME: home, ANTIGRAVITY_HOME: "/data/gemini/antigravity-cli" };
      const { account: overrideAccount } = usage.remember({
        command: "/usr/local/bin/agy",
        args: [],
        env: override,
      });

      const discovered = new Set(
        (await source.discover({ kind: "global" })).map((entry) => entry.key),
      );
      expect(discovered.has(accountKey({ HOME: home }))).toBe(true);
      expect(discovered.has(overrideAccount)).toBe(true);
      expect(discovered.size).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("Usage discovers nothing globally without a launch or an Antigravity config", async () => {
    const usage = new Usage(undefined, () => ({ HOME: "/home/no-antigravity-user" }));
    expect(await usage.registration().discover({ kind: "global" })).toEqual([]);
  });

  test("Usage discovers accounts for session scope", async () => {
    const usage = new Usage();
    const source = usage.registration();

    const launch: ProviderLaunch = {
      command: "agy",
      args: [],
      env: { HOME: "/home/testuser" },
    };
    const { account } = usage.remember(launch);

    // Matching provider
    const sessionMatch = await source.discover({
      kind: "session",
      provider: "antigravity",
      env: { HOME: "/home/testuser" },
    });
    expect(sessionMatch).toEqual([
      {
        key: account,
        label: "Antigravity",
        input: { account },
      },
    ]);

    // Unrelated provider
    const sessionMismatch = await source.discover({
      kind: "session",
      provider: "muse",
      env: { HOME: "/home/testuser" },
    });
    expect(sessionMismatch).toEqual([]);
  });

  test("Usage.fetch executes runner and returns available usage report", async () => {
    const runner = vi.fn(async (_launch: ProviderLaunch, _args: string[]) => sampleAgyUsageJson);
    const usage = new Usage(runner, () => ({ HOME: "/home/unused-fallback" }));
    const source = usage.registration();

    const launch: ProviderLaunch = {
      command: "agy",
      args: ["--user-flag"],
      env: { HOME: "/home/testuser" },
    };
    const { account } = usage.remember(launch);

    const report = await source.fetch({ account });
    expect(report).toEqual({
      status: "available",
      windows: [
        {
          id: "gemini-weekly",
          label: "Gemini · Weekly",
          shortLabel: "Gemini wk",
          summary: true,
          usedPct: 2,
          remainingPct: 98,
          resetsAt: "2026-11-01T09:42:13Z",
          tone: "ok",
        },
        {
          id: "gemini-5h",
          label: "Gemini · 5h",
          shortLabel: "Gemini 5h",
          usedPct: 10,
          remainingPct: 90,
          resetsAt: "2026-10-26T02:21:56Z",
          tone: "ok",
        },
        {
          id: "claude-gpt-oss-weekly",
          label: "Claude & GPT-OSS · Weekly",
          shortLabel: "Claude/OSS wk",
          summary: true,
          usedPct: 0,
          remainingPct: 100,
          resetsAt: "2026-11-01T21:28:07Z",
          tone: "ok",
        },
        {
          id: "claude-gpt-oss-5h",
          label: "Claude & GPT-OSS · 5h · Disabled",
          shortLabel: "Claude/OSS 5h",
          usedPct: null,
          remainingPct: null,
          resetsAt: null,
          tone: "default",
        },
        {
          id: "gemini-argon-weekly",
          label: "Gemini 4 Argon · Weekly",
          shortLabel: "Argon wk",
          summary: true,
          usedPct: 100,
          remainingPct: 0,
          resetsAt: "2026-10-26T12:48:38Z",
          tone: "danger",
        },
      ],
      details: [
        {
          id: "observed",
          label: "Observed",
          value: expect.any(String),
        },
      ],
    });

    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith(launch, []);
  });

  test("Usage.fetch handles agy runner non-zero error", async () => {
    const runner = vi.fn(async () => {
      throw new Error("Command failed: agy process crashed");
    });
    const usage = new Usage(runner);
    const source = usage.registration();

    const launch: ProviderLaunch = { command: "agy", args: [], env: {} };
    const { account } = usage.remember(launch);

    const report = await source.fetch({ account });
    expect(report).toEqual({
      status: "error",
      error: "Command failed: agy process crashed",
    });
  });

  test("Usage.fetch returns rejected problem when unauthenticated", async () => {
    const runner = vi.fn(async () =>
      JSON.stringify({
        status: "ERROR",
        response: "User is not authenticated. Please run agy and sign in.",
      }),
    );
    const usage = new Usage(runner);
    const source = usage.registration();

    const launch: ProviderLaunch = { command: "agy", args: [], env: {} };
    const { account } = usage.remember(launch);

    const report = await source.fetch({ account });
    expect(report).toEqual({
      status: "unavailable",
      problem: {
        kind: "rejected",
        status: 401,
        refreshedBy: "agy",
      },
    });
  });

  test("Usage.fetch returns no_quota when agy returns empty groups", async () => {
    const runner = vi.fn(async () =>
      JSON.stringify({
        status: "SUCCESS",
        command: { name: "usage", data: { groups: [] } },
      }),
    );
    const usage = new Usage(runner, () => ({ HOME: "/home/unused-fallback" }));
    const source = usage.registration();

    const launch: ProviderLaunch = { command: "agy", args: [], env: {} };
    const { account } = usage.remember(launch);

    const report = await source.fetch({ account });
    expect(report).toEqual({
      status: "unavailable",
      problem: {
        kind: "no_quota",
        detail: "No usage quota reported by agy",
      },
    });
  });

  test("Usage.fetch throws for unknown account", async () => {
    const usage = new Usage();
    const source = usage.registration();

    await expect(source.fetch({ account: "unknown-account" })).rejects.toThrow(
      "Antigravity login no longer exists",
    );
  });

  test("provider contribution registers both provider and usage source", () => {
    let registeredProvider: ProviderRegistration | undefined;
    let registeredUsage: UsageSourceRegistration | undefined;

    const server = {
      registerProvider(p: ProviderRegistration) {
        registeredProvider = p;
      },
      registerUsageSource(u: UsageSourceRegistration) {
        registeredUsage = u;
      },
    };

    contribute(server);

    expect(registeredProvider?.id).toBe("antigravity");
    expect(registeredUsage?.id).toBe("antigravity");
  });

  test("createAntigravityProvider status() remembers launch in usage", async () => {
    const usage = new Usage(undefined, () => ({ HOME: "/home/no-antigravity-user" }));
    const provider = createAntigravityProvider(usage);

    const launch: ProviderLaunch = {
      command: "agy",
      args: [],
      env: { HOME: "/home/probed-user" },
    };

    // Before status probe
    expect(await usage.registration().discover({ kind: "global" })).toEqual([]);

    // Simulate status check (mock probe internally by spying or calling status with launch)
    await provider.status({ launch }).catch(() => {});

    // Usage should now remember the launch
    const discovered = await usage.registration().discover({ kind: "global" });
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.key).toBe(accountKey(launch.env));
  });
});
