import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fetchUsage } from "./usage.js";

it("shows the reported Pro percentage pools without treating bonus spend as an overage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-reported-pools-"));
  const locator = join(directory, "auth.json");
  try {
    await writeFile(locator, JSON.stringify({ accessToken: "fixture-token" }));
    const report = await fetchUsage({ store: "file", locator }, async () =>
      Response.json({
        billingCycleStart: "2026-09-25T07:10:08.000Z",
        billingCycleEnd: "2026-10-25T07:10:08.000Z",
        planUsage: {
          totalSpend: 5717,
          includedSpend: 2000,
          bonusSpend: 3717,
          limit: 2000,
          autoPercentUsed: 9.157777777777778,
          apiPercentUsed: 35.46666666666667,
          totalPercentUsed: 11.54949494949495,
        },
        spendLimitUsage: { individualLimit: 100, individualRemaining: 100, limitType: "user" },
      }),
    );
    expect(report).toMatchObject({
      status: "available",
      windows: [
        { id: "plan_usage", usedPct: 11.54949494949495 },
        { id: "cursor_usage", usedPct: 9.157777777777778 },
        { id: "third_party_usage", usedPct: 35.46666666666667 },
      ],
      balances: [],
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["Pro+", 42015, 7000, 34.583333333333336, 4.6818181818181825, 32.07251908396947],
  ["Teams", 77145, 2000, 61.8352380952381, 61.09, 61.716],
] as const)(
  "preserves the reported %s pools separately from bonus-inclusive dollars",
  async (_plan, totalSpend, limit, autoPercentUsed, apiPercentUsed, totalPercentUsed) => {
    const report = await reportFor({
      totalSpend,
      limit,
      autoPercentUsed,
      apiPercentUsed,
      totalPercentUsed,
    });
    expect(report).toMatchObject({
      status: "available",
      windows: [
        { id: "plan_usage", usedPct: totalPercentUsed, summary: true },
        { id: "cursor_usage", usedPct: autoPercentUsed },
        { id: "third_party_usage", usedPct: apiPercentUsed },
      ],
      balances: [],
    });
  },
);

it("retains a zero percentage without inventing absent breakdowns", async () => {
  expect(await reportFor({ totalPercentUsed: "0", autoPercentUsed: null })).toMatchObject({
    status: "available",
    windows: [{ id: "plan_usage", usedPct: 0, remainingPct: 100 }],
    balances: [],
  });
});

it("keeps dollar-only reports when the response has no percentages", async () => {
  expect(await reportFor({ totalSpend: 1500, remaining: 2500, limit: 4000 })).toMatchObject({
    status: "available",
    windows: [],
    balances: [{ id: "plan_usage", used: 15, remaining: 25, limit: 40, unit: "usd" }],
  });
});

async function reportFor(planUsage: Record<string, unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "cursor-usage-pools-"));
  const locator = join(directory, "auth.json");
  try {
    await writeFile(locator, JSON.stringify({ accessToken: "fixture-token" }));
    return await fetchUsage({ store: "file", locator }, async () => Response.json({ planUsage }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
