import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { openSettingsHostSection } from "../support/helpers/settings";
import {
  expectUsageBalanceInsideCard,
  installUsageReportsFixture,
  type UsageReportsFixture,
} from "../support/helpers/usage-reports";
import { refreshAllUsage, showUsageAs } from "../support/helpers/usage-sidebar-item";

const ICON = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="currentColor"/></svg>';

function forcedRefreshCount(usage: UsageReportsFixture): number {
  return usage.listRequests().filter((request) => request.forceRefresh).length;
}

function report(input: {
  sourceId: string;
  sourceLabel: string;
  report:
    | Partial<Extract<UsageReportEntry["report"], { status: "available" }>>
    | Exclude<UsageReportEntry["report"], { status: "available" }>;
}): UsageReportEntry {
  return {
    id: `${input.sourceId}:account`,
    account: { label: input.sourceId === "alpha" ? "dev@example.com" : undefined },
    fetchedAt: "2026-01-01T00:00:00.000Z",
    sourceId: input.sourceId,
    sourceLabel: input.sourceLabel,
    icon: ICON,
    report:
      input.report.status === "error" || input.report.status === "unavailable"
        ? input.report
        : {
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
              windows: [{ id: "session", label: "Session", usedPct: 7 }],
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

    // The shared percentages setting applies to the host section.
    await expect(page.getByTestId("usage-options-menu")).toBeVisible();
    const hostUsageUrl = page.url();
    await page.goto("/usage");
    await showUsageAs(page, "remaining");
    await page.goto(hostUsageUrl);
    await expect(card.getByText("30% left")).toBeVisible();
    await expect(card.getByText("93% left")).toBeVisible();
  });

  test("refresh forces a fresh report", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const windows = (usedPct: number) => [{ id: "w", label: "Weekly", usedPct }];
    // The sidebar summary and the section each load reports; only Refresh forces one.
    const usage = await installUsageReportsFixture(page, {
      lists: [
        (request) => [
          report({
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { windows: windows(request.forceRefresh ? 64 : 23) },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");
    const card = page.getByTestId("usage-card");
    await expect(card.getByText("23%")).toBeVisible({ timeout: 10_000 });

    await refreshAllUsage(page);
    await expect.poll(() => forcedRefreshCount(usage)).toBe(1);
    await expect(card.getByText("64%")).toBeVisible();
  });

  test("keeps a localized balance reset within its usage card", async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 320, height: 844 });
    const serverId = getServerId();
    await installUsageReportsFixture(page, {
      lists: [
        [
          report({
            sourceId: "fixture",
            sourceLabel: "Fixture plan",
            report: {
              balances: [
                {
                  id: "credits",
                  label: "Credits available for additional usage",
                  remaining: 999_999_999_999_999,
                  unit: "credits",
                  resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                },
              ],
            },
          }),
        ],
      ],
    });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");

    await expectUsageBalanceInsideCard(page, "credits");
  });

  test("asks to update a host without usage support and never calls it", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSupported: false });

    await gotoAppShell(page);
    await openSettings(page);
    await openSettingsHostSection(page, serverId, "usage");

    await expect(
      // Names the host: "Update Laptop to see usage".
      page.getByTestId("usage-card").getByText(/^Update (?!the host ).+ to see usage$/),
    ).toBeVisible({ timeout: 10_000 });
    expect(usage.listRequests()).toHaveLength(0);
  });
});
