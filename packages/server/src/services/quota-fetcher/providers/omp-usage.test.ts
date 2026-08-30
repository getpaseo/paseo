import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { OmpUsageExec, OmpUsageReport } from "./omp-usage.js";
import { OmpUsageRunner, providerUsageFromOmpReport } from "./omp-usage.js";
import { CodexQuotaProvider } from "./codex.js";
import { OpencodeGoQuotaProvider } from "./opencode-go.js";
import { ZaiQuotaProvider } from "./zai.js";
import { afterEach, describe, expect, it, vi } from "vitest";

function ompOutput(reports: unknown[]): string {
  return JSON.stringify({ generatedAt: 1, reports });
}

function zaiReport(overrides: Partial<OmpUsageReport> = {}): OmpUsageReport {
  return {
    provider: "zai",
    fetchedAt: 1_788_033_537_027,
    limits: [
      {
        id: "zai:credits:5h",
        label: "ZAI 5 Hours Credit Quota",
        scope: { provider: "zai", windowId: "5h", shared: true },
        window: { id: "5h", label: "5 Hours", durationMs: 18_000_000, resetsAt: 1_788_046_030_953 },
        amount: {
          used: 1074,
          limit: 2000,
          remaining: 925,
          usedFraction: 0.537,
          remainingFraction: 0.463,
          unit: "credits",
        },
      },
      {
        id: "zai:credits:1w",
        label: "ZAI Weekly Credit Quota",
        scope: { provider: "zai", windowId: "1w", shared: true },
        window: { id: "1w", label: "Weekly", durationMs: 604_800_000, resetsAt: 1_788_528_006_997 },
        amount: { used: 4844, limit: 10_000, unit: "credits" },
      },
    ],
    metadata: { planType: "lite", email: "user@example.com" },
    ...overrides,
  } as OmpUsageReport;
}

function execReturning(stdout: string): OmpUsageExec {
  return async () => ({ stdout, stderr: "" });
}

const failingExec: OmpUsageExec = async () => {
  throw new Error("spawn omp ENOENT");
};

describe("OmpUsageRunner", () => {
  it("runs omp usage for the requested provider and returns its report", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner = new OmpUsageRunner({
      logger: createTestLogger(),
      command: ["omp", "--profile", "work"],
      exec: async (command, args) => {
        calls.push({ command, args });
        return { stdout: ompOutput([zaiReport()]), stderr: "" };
      },
    });

    const report = await runner.fetchReport("zai");

    expect(calls).toEqual([
      {
        command: "omp",
        args: ["--profile", "work", "usage", "--json", "--provider", "zai"],
      },
    ]);
    expect(report?.provider).toBe("zai");
    expect(report?.limits).toHaveLength(2);
  });

  it("returns null when the provider has no report", async () => {
    const runner = new OmpUsageRunner({
      logger: createTestLogger(),
      exec: execReturning(ompOutput([{ provider: "openai-codex", limits: [] }])),
    });

    await expect(runner.fetchReport("zai")).resolves.toBeNull();
  });

  it("returns null when omp fails or prints garbage", async () => {
    const failing = new OmpUsageRunner({ logger: createTestLogger(), exec: failingExec });
    const garbage = new OmpUsageRunner({
      logger: createTestLogger(),
      exec: execReturning("not json"),
    });

    await expect(failing.fetchReport("zai")).resolves.toBeNull();
    await expect(garbage.fetchReport("zai")).resolves.toBeNull();
  });
});

describe("providerUsageFromOmpReport", () => {
  it("maps limits into windows with percent, reset time, tone, and plan label", () => {
    const usage = providerUsageFromOmpReport({
      report: zaiReport(),
      providerId: "zai",
      displayName: "Z.ai",
    });

    expect(usage).toEqual({
      providerId: "zai",
      displayName: "Z.ai",
      status: "available",
      planLabel: "lite",
      sourceLabel: "Oh My Pi",
      fetchedAt: "2026-08-29T19:58:57.027Z",
      windows: [
        {
          id: "zai:credits:5h",
          label: "ZAI 5 Hours Credit Quota",
          usedPct: 53.7,
          remainingPct: 46.3,
          resetsAt: "2026-08-29T23:27:10.953Z",
          tone: "ok",
        },
        {
          id: "zai:credits:1w",
          label: "ZAI Weekly Credit Quota",
          usedPct: 48.44,
          remainingPct: 51.56,
          resetsAt: "2026-09-04T13:20:06.997Z",
          tone: "ok",
        },
      ],
      balances: [],
      details: [],
      error: null,
    });
  });

  it("derives percent from used/limit when usedFraction is absent", () => {
    const report = zaiReport();
    const limits = report.limits ?? [];
    (limits[0] as { amount: Record<string, unknown> }).amount = { used: 50, limit: 200 };

    const usage = providerUsageFromOmpReport({
      report,
      providerId: "zai",
      displayName: "Z.ai",
    });

    expect(usage?.windows[0]?.usedPct).toBe(25);
  });

  it("returns null when no limit carries usable amounts", () => {
    const usage = providerUsageFromOmpReport({
      report: zaiReport({ limits: [{ id: "x", amount: null }] }),
      providerId: "zai",
      displayName: "Z.ai",
    });

    expect(usage).toBeNull();
  });
});

describe("ZaiQuotaProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the OMP report over the env-key subscription listing", async () => {
    const provider = new ZaiQuotaProvider({
      logger: createTestLogger(),
      fetch: (() => {
        throw new Error("must not hit the subscription API");
      }) as typeof fetch,
      exec: execReturning(ompOutput([zaiReport()])),
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("available");
    expect(usage.sourceLabel).toBe("Oh My Pi");
    expect(usage.windows.map((window) => window.id)).toEqual(["zai:credits:5h", "zai:credits:1w"]);
  });

  it("falls back to the env-key subscription listing when OMP has no report", async () => {
    vi.stubEnv("ZAI_API_KEY", "zai_test_token");
    const provider = new ZaiQuotaProvider({
      logger: createTestLogger(),
      fetch: (async () =>
        new Response(
          JSON.stringify({
            data: [{ productName: "GLM Coding Max", status: "VALID" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
      exec: execReturning(ompOutput([])),
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("available");
    expect(usage.planLabel).toBe("GLM Coding Max");
    expect(usage.windows).toEqual([]);
  });

  it("stays unavailable when OMP has no report and no env key is set", async () => {
    vi.stubEnv("ZAI_API_KEY", "");
    vi.stubEnv("GLM_API_KEY", "");
    const provider = new ZaiQuotaProvider({
      logger: createTestLogger(),
      exec: failingExec,
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("unavailable");
  });
});

describe("CodexQuotaProvider", () => {
  it("prefers OpenAI plan usage reported by OMP", async () => {
    const provider = new CodexQuotaProvider({
      logger: createTestLogger(),
      fetch: (() => {
        throw new Error("must not hit the Codex API");
      }) as typeof fetch,
      exec: execReturning(
        ompOutput([
          {
            provider: "openai-codex",
            fetchedAt: 1_788_033_538_807,
            limits: [
              {
                id: "primary",
                label: "5 hours",
                amount: { usedFraction: 0.12 },
                window: { resetsAt: 1_788_042_238_807 },
              },
            ],
            metadata: { planType: "ChatGPT Plus" },
          },
        ]),
      ),
    });

    await expect(provider.fetchUsage()).resolves.toMatchObject({
      providerId: "codex",
      displayName: "Codex",
      sourceLabel: "Oh My Pi",
      planLabel: "ChatGPT Plus",
    });
  });

  it("prefers native Codex usage over an available OMP report", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "paseo-codex-"));
    try {
      await writeFile(
        join(codexHome, "auth.json"),
        JSON.stringify({ tokens: { access_token: "codex_test_token" } }),
      );
      const provider = new CodexQuotaProvider({
        logger: createTestLogger(),
        codexHome,
        fetch: (async () =>
          new Response(
            JSON.stringify({
              plan_type: "Pro",
              rate_limit: { primary_window: { used_percent: 12 } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          )) as typeof fetch,
        exec: execReturning(
          ompOutput([
            {
              provider: "openai-codex",
              limits: [{ id: "primary", amount: { usedFraction: 0.12 } }],
              metadata: { planType: "ChatGPT Plus" },
            },
          ]),
        ),
      });

      await expect(provider.fetchUsage()).resolves.toMatchObject({
        providerId: "codex",
        planLabel: "Pro",
      });
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

describe("OpencodeGoQuotaProvider", () => {
  it("maps the OMP report with 5h, weekly, and monthly windows", async () => {
    const provider = new OpencodeGoQuotaProvider({
      logger: createTestLogger(),
      exec: execReturning(
        ompOutput([
          {
            provider: "opencode-go",
            fetchedAt: 1_788_033_538_807,
            limits: [
              {
                id: "rolling-5h",
                label: "5 Hour limit",
                scope: { provider: "opencode-go", windowId: "5h" },
                window: { id: "5h", resetsAt: 1_788_042_238_807 },
                amount: { used: 2, limit: null, usedFraction: 0.02, unit: "percent" },
              },
              {
                id: "weekly",
                label: "Weekly limit",
                scope: { provider: "opencode-go", windowId: "7d" },
                window: { id: "7d", resetsAt: 1_788_134_400_807 },
                amount: { used: 23, limit: null, usedFraction: 0.23, unit: "percent" },
              },
              {
                id: "monthly",
                label: "Monthly limit",
                scope: { provider: "opencode-go", windowId: "monthly" },
                window: { id: "monthly", resetsAt: 1_788_600_167_807 },
                amount: { used: 98, limit: null, usedFraction: 0.98, unit: "percent" },
              },
            ],
            metadata: { planType: "OpenCode Go" },
          },
        ]),
      ),
    });

    const usage = await provider.fetchUsage();

    expect(usage).toMatchObject({
      providerId: "opencode-go",
      displayName: "OpenCode Go",
      status: "available",
      planLabel: "OpenCode Go",
    });
    expect(usage.windows.map((window) => window.usedPct)).toEqual([2, 23, 98]);
    expect(usage.windows[2]?.tone).toBe("danger");
  });

  it("is unavailable when OMP cannot serve the report", async () => {
    const provider = new OpencodeGoQuotaProvider({
      logger: createTestLogger(),
      exec: failingExec,
    });

    const usage = await provider.fetchUsage();

    expect(usage.status).toBe("unavailable");
  });
});
