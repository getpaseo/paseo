import { expect, test } from "./fixtures";
import { gotoAppShell, openSettings } from "./helpers/app";
import { installProviderUsageFixture } from "./helpers/provider-usage";
import { getServerId } from "./helpers/server-id";
import { openSettingsHostSection } from "./helpers/settings";

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
