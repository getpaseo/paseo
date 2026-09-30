import path from "node:path";
import type { Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";

// Two hours reads "2h ago" for an hour, so the assertion cannot race the clock.
function twoHoursAgo(): string {
  return new Date(Date.now() - 2 * 60 * 60_000).toISOString();
}

/** Set PASEO_QA_SCREENSHOT_DIR to keep a QA screenshot. */
async function qaScreenshot(page: Page, name: string) {
  const directory = process.env.PASEO_QA_SCREENSHOT_DIR;
  if (!directory) return;
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".__expo_fast_refresh { display: none !important; }" });
  await page.screenshot({ path: path.join(directory, `${name}.png`) });
}

/** The host selector names the host shown, even when it is the only one. */
async function shownHostLabel(page: Page): Promise<string> {
  const selector = page.locator('[data-testid="usage-host-switcher"]:visible');
  await expect(selector).toHaveAccessibleName(/^Usage host: .+/, { timeout: 10_000 });
  return (await selector.innerText()).trim();
}

test.describe("usage screen", () => {
  test("opens from the sidebar on the host's reports, naming the one host", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          {
            id: "alpha:a",
            account: {},
            fetchedAt: twoHoursAgo(),
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: {
              status: "available",
              windows: [{ id: "weekly", label: "Weekly", usedPct: 31 }],
            },
          },
          {
            id: "beta:b",
            account: {},
            fetchedAt: "2026-01-01T00:00:00.000Z",
            sourceId: "beta",
            sourceLabel: "Beta plan",
            report: { status: "unavailable", windows: [] },
          },
        ],
      ],
    });

    await gotoAppShell(page);
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();
    await expect(page).toHaveURL(/\/usage$/);
    await usage.waitForListRequests(1);

    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    const hostLabel = await shownHostLabel(page);
    await expect(page.locator('[data-testid="usage-host-switcher"]:visible')).toHaveAccessibleName(
      `Usage host: ${hostLabel}`,
    );
    await qaScreenshot(page, "phase7-usage-screen-one-host");
    await expect(group.getByText("31%")).toBeVisible();
    await expect(group.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(group.getByText("Unavailable", { exact: true })).toBeVisible();

    await group.getByTestId("usage-refresh").first().hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated 2h ago");
    await expect(group.getByTestId("usage-freshness")).toHaveCount(0);
  });

  test("refreshes one report from its card", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const beta: UsageReportEntry = {
      id: "beta:b",
      account: {},
      fetchedAt: twoHoursAgo(),
      sourceId: "beta",
      sourceLabel: "Beta plan",
      report: {
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct: 12 }],
      },
    };
    const alpha = (usedPct: number, fetchedAt: string): UsageReportEntry => ({
      id: "alpha:a",
      account: {},
      fetchedAt,
      sourceId: "alpha",
      sourceLabel: "Alpha plan",
      report: {
        status: "available",
        windows: [{ id: "weekly", label: "Weekly", usedPct }],
      },
    });
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [alpha(31, twoHoursAgo()), beta],
        () => [
          alpha(58, new Date().toISOString()),
          { ...beta, fetchedAt: new Date().toISOString() },
        ],
      ],
    });

    await gotoAppShell(page);
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();
    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("31%")).toBeVisible({ timeout: 10_000 });

    const alphaRefresh = group.getByTestId("usage-refresh").first();
    await alphaRefresh.click();
    await usage.waitForListRequests(2);
    expect(usage.listRequests()).toEqual([
      { forceRefresh: false, reportIds: undefined },
      { forceRefresh: true, reportIds: ["alpha:a"] },
    ]);
    await expect(group.getByText("58%")).toBeVisible();
    await expect(group.getByText("12%")).toBeVisible();

    await group.getByTestId("usage-refresh").nth(1).hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated 2h ago");
    await alphaRefresh.hover();
    await expect(page.getByTestId("usage-freshness-tooltip")).toHaveText("Updated just now");
  });

  test("shows the host once it connects after a cold load on a phone", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          {
            id: "alpha:a",
            account: {},
            fetchedAt: twoHoursAgo(),
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: { status: "available", windows: [] },
          },
        ],
      ],
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/usage");
    await usage.waitForListRequests(1);

    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("Alpha plan", { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(group.getByTestId("usage-freshness")).toHaveText("Updated 2h ago");
  });

  test("tells the user to update a host without usage support", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSupported: false });

    await gotoAppShell(page);
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();

    const hostLabel = await shownHostLabel(page);
    await expect(
      page.getByTestId(`usage-host-${serverId}`).getByText(`Update ${hostLabel} to see usage`, {
        exact: true,
      }),
    ).toBeVisible({ timeout: 10_000 });
    await qaScreenshot(page, "phase7-usage-update-host");
    expect(usage.listRequests()).toHaveLength(0);
  });
});
