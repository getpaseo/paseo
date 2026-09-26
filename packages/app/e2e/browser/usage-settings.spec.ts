import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";

const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';

function report(input: {
  sourceId: string;
  sourceLabel: string;
  report: Partial<UsageReportEntry["report"]>;
}): UsageReportEntry {
  return {
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    icon: ICON,
    report: {
      account: { key: `${input.sourceId}-account` },
      status: "available",
      windows: [],
      ...input.report,
    },
  };
}

test.describe("usage settings", () => {
  test("renders every report returned by usage.list_reports", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: {
              planLabel: "Max",
              account: { key: "a", label: "dev@example.com" },
              windows: [{ id: "session", label: "Session", usedPct: 7, headline: true }],
            },
          }),
          report({
            sourceId: "beta",
            sourceLabel: "Beta plan",
            report: {
              planLabel: "Coding plan",
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
          }),
          report({
            sourceId: "gamma",
            sourceLabel: "Gamma plan",
            report: { status: "error", error: "Gamma auth expired" },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    expect(usage.listRequests()).toHaveLength(0);
    await openSettingsHostSection(page, serverId, "usage");
    await usage.waitForListRequests(1);

    const card = page.getByTestId("usage-card");
    await expect(card.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(card.getByText("dev@example.com", { exact: true })).toBeVisible();
    await expect(card.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(card.getByText("70%")).toBeVisible();
    await expect(card.getByText("1,234 left", { exact: true })).toBeVisible();
    await expect(card.getByText("$5.00 / $20.00", { exact: true })).toBeVisible();
    await expect(card.getByText("2026-12-31", { exact: true })).toBeVisible();
    await expect(card.getByText("Gamma auth expired", { exact: true })).toBeVisible();
  });

  test("refresh forces a fresh report", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const windows = (usedPct: number) => [{ id: "w", label: "Weekly", usedPct }];
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { windows: windows(23) },
          }),
        ],
        [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { windows: windows(64) },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    await expect(page.getByText("23%")).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await usage.waitForListRequests(2);

    expect(usage.listRequests().at(-1)).toEqual({ forceRefresh: true });
    await expect(page.getByText("64%")).toBeVisible();
  });

  test("asks to update a host without usage sources and never calls it", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSources: false });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");

    await expect(
      page.getByTestId("usage-card").getByText("Update the host to see usage", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });
    expect(usage.listRequests()).toHaveLength(0);
  });
});
