import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { installProviderUsageFixture } from "../support/helpers/provider-usage";
import { getServerId } from "../support/helpers/server-id";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { openCompactSettings, openSettingsHostSection } from "../support/helpers/settings";

test.describe("provider usage settings", () => {
  test("renders every provider returned by the daemon usage RPC", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "claude",
            displayName: "Claude",
            status: "available",
            planLabel: "Max 20x",
            windows: [{ id: "session", label: "Session", usedPct: 7 }],
          },
          {
            providerId: "codex",
            displayName: "Codex",
            status: "available",
            planLabel: "Pro 20x",
            windows: [{ id: "weekly", label: "Weekly", usedPct: 29 }],
          },
          {
            providerId: "glm",
            displayName: "GLM coding plan",
            status: "available",
            planLabel: "GLM coding plan",
            sourceLabel: "OpenUsage 0.6.27",
            windows: [
              { id: "biweekly", label: "Biweekly", usedPct: 23 },
              { id: "daily", label: "Daily", remainingPct: 30 },
            ],
            balances: [
              { id: "credits", label: "Credits", remaining: 1234, unit: "credits" },
              { id: "extra", label: "Extra usage", used: 5, limit: 20, unit: "usd" },
            ],
            details: [{ id: "valid", label: "Valid until", value: "2026-12-31" }],
          },
        ],
      },
    ]);

    await gotoAppShell(page);
    await openSettings(page);
    expect(usageFixture.requestCount()).toBe(0);
    await openSettingsHostSection(page, serverId, "usage");
    await usageFixture.waitForRequestCount(1);

    const card = page.getByTestId("provider-usage-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText("Claude", { exact: true })).toBeVisible();
    await expect(card.getByText("Codex", { exact: true })).toBeVisible();
    await expect(card.getByText("GLM coding plan", { exact: true }).first()).toBeVisible();
    await expect(card.getByText("Biweekly", { exact: true })).toBeVisible();
    await expect(card.getByText("Daily", { exact: true })).toBeVisible();
    await expect(card.getByText("70%")).toBeVisible();
    await expect(card.getByText("Credits", { exact: true })).toBeVisible();
    await expect(card.getByText("1,234 left", { exact: true })).toBeVisible();
    await expect(card.getByText("Extra usage", { exact: true })).toBeVisible();
    await expect(card.getByText("$5.00 / $20.00", { exact: true })).toBeVisible();
    await expect(card.getByText("Valid until", { exact: true })).toBeVisible();
    await expect(card.getByText("2026-12-31", { exact: true })).toBeVisible();
    await expect(card.getByText(/OpenUsage 0\.6\.27/)).toBeVisible();
  });

  test("refresh invalidates and refetches usage", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usageFixture = await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "glm",
            displayName: "GLM coding plan",
            status: "available",
            planLabel: "GLM coding plan",
            windows: [{ id: "biweekly", label: "Biweekly", usedPct: 23 }],
          },
        ],
      },
      {
        fetchedAt: "2026-06-19T00:01:00.000Z",
        providers: [
          {
            providerId: "glm",
            displayName: "GLM coding plan",
            status: "available",
            planLabel: "GLM coding plan",
            windows: [{ id: "biweekly", label: "Biweekly", usedPct: 64 }],
          },
        ],
      },
    ]);

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    await usageFixture.waitForRequestCount(1);
    await expect(page.getByText("23%")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await usageFixture.waitForRequestCount(2);

    expect(usageFixture.requestCount()).toBe(2);
    await expect(page.getByText("64%")).toBeVisible();
  });

  test("one provider error does not collapse the usage list", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    await installProviderUsageFixture(page, [
      {
        fetchedAt: "2026-06-19T00:00:00.000Z",
        providers: [
          {
            providerId: "claude",
            displayName: "Claude",
            status: "error",
            planLabel: null,
            windows: [],
            error: "Claude auth expired",
          },
          {
            providerId: "codex",
            displayName: "Codex",
            status: "available",
            planLabel: "Pro 20x",
            windows: [{ id: "weekly", label: "Weekly", usedPct: 71 }],
          },
        ],
      },
    ]);

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");

    const card = page.getByTestId("provider-usage-card");
    await expect(card).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText("Error", { exact: true })).toBeVisible();
    await expect(card.getByText("Claude auth expired", { exact: true })).toBeVisible();
    await expect(card.getByText("Codex", { exact: true })).toBeVisible();
    await expect(card.getByText("71%")).toBeVisible();
  });
});

const bankedReset = {
  id: "reset-1",
  resetType: "codex_rate_limits",
  supportedByPlan: true,
  status: "available",
  grantedAt: "2026-09-01T00:00:00Z",
  expiresAt: "2099-10-01T00:00:00Z",
  title: "Referral reward",
  description: "One Codex usage reset",
};

function codexUsage(used: boolean) {
  return {
    fetchedAt: "2026-09-06T00:00:00Z",
    providers: [
      {
        providerId: "codex",
        displayName: "Codex",
        status: "available" as const,
        planLabel: "Pro",
        windows: [{ id: "weekly", label: "Weekly", usedPct: used ? 0 : 100 }],
        bankedResets: {
          availableCount: used ? 0 : 1,
          error: null,
          credits: [{ ...bankedReset, status: used ? "redeemed" : "available" }],
        },
      },
    ],
  };
}

test("banked resets confirm, prevent duplicate submissions, and refresh usage", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const serverId = getServerId();
  const consumed: string[] = [];
  let finishConsume!: () => void;
  const pendingConsume = new Promise<void>((resolve) => {
    finishConsume = resolve;
  });
  const fixture = await installProviderUsageFixture(page, [codexUsage(false), codexUsage(true)], {
    consume: async ({ creditId }) => {
      consumed.push(creditId);
      await pendingConsume;
      return { outcome: "reset" };
    },
  });
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, serverId, "usage");
  const card = page.getByTestId("provider-usage-card");
  await expect(card.getByText("1 available", { exact: true })).toBeVisible();
  await expect(card.getByText("Referral reward", { exact: true })).toBeVisible();
  await expect(card.getByText(/Expires.*2099/)).toBeVisible();
  await testInfo.attach("banked-resets-before", {
    body: await card.screenshot({ path: testInfo.outputPath("banked-resets-before.png") }),
    contentType: "image/png",
  });

  page.once("dialog", (dialog) => dialog.dismiss());
  await card.getByRole("button", { name: "Use reset", exact: true }).click();
  await expect(card.getByRole("button", { name: "Use reset", exact: true })).toBeEnabled();
  expect(consumed).toEqual([]);

  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Use reset", exact: true }).click();
  await expect.poll(() => consumed).toEqual(["reset-1"]);
  await expect(card.getByRole("button", { name: "Use reset", exact: true })).toBeDisabled();
  finishConsume();
  await fixture.waitForRequestCount(2);
  await expect(
    card.getByText("Banked reset used. Codex usage limits have been reset."),
  ).toBeVisible();
  await expect(card.getByText("0 available", { exact: true })).toBeVisible();
  await expect(card.getByText("Used", { exact: true })).toBeVisible();
  await expect(card.getByText("0%", { exact: true })).toBeVisible();
  await testInfo.attach("banked-resets-after", {
    body: await card.screenshot({ path: testInfo.outputPath("banked-resets.png") }),
    contentType: "image/png",
  });
});

test("failed banked resets show an error and retry with the same idempotency key", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const requests: Array<{ creditId: string; idempotencyKey: string }> = [];
  await installProviderUsageFixture(page, [codexUsage(false)], {
    consume: async (request) => {
      requests.push(request);
      if (requests.length === 1)
        return { error: "Codex request timed out. Refresh usage before retrying." };
      return { outcome: "already_redeemed" };
    },
  });
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "usage");
  const card = page.getByTestId("provider-usage-card");
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Use reset", exact: true }).click();
  await expect(
    card.getByText("Codex request timed out. Refresh usage before retrying."),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(card.getByText(/requestType=|code=codex_banked_reset_failed/)).toHaveCount(0);
  await testInfo.attach("banked-resets-error", {
    body: await card.screenshot({ path: testInfo.outputPath("banked-resets.png") }),
    contentType: "image/png",
  });
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(card.getByText("This banked reset has already been used.")).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].idempotencyKey).not.toBe("");
});

test("expired and unsupported resets cannot be used", async ({ page }) => {
  test.setTimeout(120_000);
  const payload = codexUsage(false);
  payload.providers[0].bankedResets.credits = [
    { ...bankedReset, expiresAt: "2000-01-01T00:00:00Z" },
    { ...bankedReset, id: "reset-2", resetType: "future_reset" },
    { ...bankedReset, id: "reset-3", status: "redeeming" },
    { ...bankedReset, id: "reset-4", supportedByPlan: false },
  ];
  await installProviderUsageFixture(page, [payload]);
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "usage");
  const card = page.getByTestId("provider-usage-card");
  await expect(card.getByText("Expired", { exact: true })).toBeVisible();
  await expect(card.getByText("Unsupported", { exact: true })).toBeVisible();
  await expect(card.getByText("Processing", { exact: true })).toBeVisible();
  await expect(card.getByText("Not supported by plan", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Use reset", exact: true })).toHaveCount(0);
});

test("hosts without the banked reset capability never offer redemption", async ({ page }) => {
  test.setTimeout(120_000);
  await installProviderUsageFixture(page, [codexUsage(false)], { supportsBankedResets: false });
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "usage");
  const card = page.getByTestId("provider-usage-card");
  await expect(card.getByText("Update this host to manage banked resets.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Use reset", exact: true })).toHaveCount(0);
});

test("redemption errors stay actionable when refreshing usage also fails", async ({ page }) => {
  test.setTimeout(120_000);
  await installProviderUsageFixture(
    page,
    [
      codexUsage(false),
      {
        fetchedAt: "2026-09-06T00:01:00Z",
        providers: [
          {
            providerId: "codex",
            displayName: "Codex",
            status: "error",
            planLabel: null,
            windows: [],
            error: "Usage temporarily unavailable",
          },
        ],
      },
    ],
    { consume: async () => ({ error: "Reset request timed out" }) },
  );
  await gotoAppShell(page);
  await openSettings(page);
  await openSettingsHostSection(page, getServerId(), "usage");
  const card = page.getByTestId("provider-usage-card");
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Use reset", exact: true }).click();
  await expect(card.getByText("Usage temporarily unavailable")).toBeVisible();
  await expect(card.getByText("Reset request timed out")).toBeVisible();
  await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("banked reset controls fit a narrow screen", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await installProviderUsageFixture(page, [codexUsage(false)]);
  await gotoAppShell(page);
  await openCompactSettings(page, buildOpenProjectRoute());
  await openSettingsHostSection(page, getServerId(), "usage");
  const card = page.getByTestId("provider-usage-card");
  await expect(card.getByText("Referral reward", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Use reset", exact: true })).toBeVisible();
  const bounds = await card.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await testInfo.attach("banked-resets-narrow", {
    body: await page.screenshot({ path: testInfo.outputPath("banked-resets-narrow.png") }),
    contentType: "image/png",
  });
});
