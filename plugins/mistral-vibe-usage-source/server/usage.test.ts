import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discover, fetchUsage } from "./usage.js";

const BUDGET_URL = "https://api.mistral.ai/v1/billing/budget";

function respond(body: unknown, status = 200): typeof fetch {
  return vi.fn(
    async () => new Response(JSON.stringify(body), { status }),
  ) as unknown as typeof fetch;
}

describe("mistral vibe usage source", () => {
  let vibeHome: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    vibeHome = mkdtempSync(join(tmpdir(), "vibe-home-"));
    originalEnv = { ...process.env };
    process.env["VIBE_HOME"] = vibeHome;
    delete process.env["MISTRAL_API_KEY"];
  });
  afterEach(() => {
    rmSync(vibeHome, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    for (const key in originalEnv) process.env[key] = originalEnv[key];
  });

  it("reports the monthly Vibe budget from the billing endpoint", async () => {
    process.env["MISTRAL_API_KEY"] = "test-key";
    const fetchApi = respond({
      vibe_budget: {
        usage_percentage: 0.35560608,
        initial_budget: 255,
        currency: "EUR",
        reset_at: "2026-12-01T00:00:00Z",
        payg_enabled: false,
      },
    });

    const report = await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, fetchApi);

    expect(fetchApi).toHaveBeenCalledWith(
      BUDGET_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer test-key" }),
      }),
    );
    expect(report).toMatchObject({
      status: "available",
      windows: [
        expect.objectContaining({
          id: "monthly",
          summary: true,
          usedPct: 0.35560608,
          resetsAt: "2026-12-01T00:00:00Z",
        }),
      ],
      details: [{ id: "extra_usage", label: "Extra usage", value: "Disabled" }],
    });
  });

  it("marks a rejected key as unavailable", async () => {
    process.env["MISTRAL_API_KEY"] = "bad-key";

    const report = await fetchUsage({ store: "env", locator: "MISTRAL_API_KEY" }, respond({}, 401));

    expect(report).toEqual({
      status: "unavailable",
      problem: { kind: "rejected", status: 401, refreshedBy: "vibe" },
    });
  });

  it("discovers the process env before VIBE_HOME/.env and never exposes the key", async () => {
    writeFileSync(join(vibeHome, ".env"), '# comment\nexport MISTRAL_API_KEY="dotenv-key"\n');
    const fromDotenv = await discover();
    expect(fromDotenv).toEqual([
      expect.objectContaining({
        harness: "Vibe",
        input: { store: "dotenv", locator: join(vibeHome, ".env") },
      }),
    ]);

    const fetchApi = respond({ vibe_budget: { usage_percentage: 1 } });
    await fetchUsage(fromDotenv[0]!.input as never, fetchApi);
    expect(fetchApi).toHaveBeenCalledWith(
      BUDGET_URL,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer dotenv-key" }),
      }),
    );

    process.env["MISTRAL_API_KEY"] = "env-key";
    const fromEnv = await discover();
    expect(fromEnv[0]?.input).toEqual({ store: "env", locator: "MISTRAL_API_KEY" });
    expect(JSON.stringify([...fromDotenv, ...fromEnv])).not.toMatch(/dotenv-key|env-key/);
  });
});
