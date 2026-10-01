import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { UsageReportEntry } from "@getpaseo/protocol/messages";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { getServerId } from "../support/helpers/server-id";
import {
  installUsageReportsFixture,
  type UsageListRequest,
  type UsageReportsFixture,
} from "../support/helpers/usage-reports";
import { expectPinnedUsage, usageItem } from "../support/helpers/usage-sidebar-item";

function forcedRefreshes(usage: UsageReportsFixture): UsageListRequest[] {
  return usage.listRequests().filter((request) => request.forceRefresh);
}

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

function hostFilter(page: Page) {
  return page.locator('[data-testid="usage-host-filter-trigger"]:visible');
}

function weeklyReport(sourceId: string, usedPct: number): UsageReportEntry {
  return {
    id: `${sourceId}:a`,
    account: {},
    fetchedAt: twoHoursAgo(),
    sourceId,
    sourceLabel: `${sourceId} plan`,
    report: { status: "available", windows: [{ id: "weekly", label: "Weekly", usedPct }] },
  };
}

test.describe("usage screen", () => {
  test("opens from the sidebar on the host's reports, with no host filter for one host", async ({
    page,
  }) => {
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
    await expect(hostFilter(page)).toHaveCount(0);
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
    // The sidebar summary and the screen each load reports; only a card's Refresh forces one.
    const usage = await installUsageReportsFixture(page, {
      lists: [
        (request) =>
          request.forceRefresh
            ? [alpha(58, new Date().toISOString())]
            : [alpha(31, twoHoursAgo()), beta],
      ],
    });

    await gotoAppShell(page);
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();
    const group = page.getByTestId(`usage-host-${serverId}`);
    await expect(group.getByText("31%")).toBeVisible({ timeout: 10_000 });

    const alphaRefresh = group.getByTestId("usage-refresh").first();
    await alphaRefresh.click();
    await expect
      .poll(() => forcedRefreshes(usage))
      .toEqual([{ forceRefresh: true, reportIds: ["alpha:a"] }]);
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
    // Without reports the footer has no Usage item; its Usage icon opens the screen.
    await page.locator('[data-testid="sidebar-usage-icon"]:visible').first().click();

    await expect(
      page.getByTestId(`usage-host-${serverId}`).getByText(/^Update .+ to see usage$/),
    ).toBeVisible({ timeout: 10_000 });
    await qaScreenshot(page, "phase7-usage-update-host");
    expect(usage.listRequests()).toHaveLength(0);
  });

  test("a host picked on the Usage screen is the sidebar's host too, after a reload", async ({
    page,
  }) => {
    test.setTimeout(420_000);
    const primaryServerId = getServerId();
    const secondary = await startIsolatedHostDaemon(
      `srv_usage_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    );
    try {
      await installUsageReportsFixture(page, { lists: [[weeklyReport("alpha", 31)]] });
      await installUsageReportsFixture(page, {
        port: secondary.port,
        lists: [[weeklyReport("beta", 12)]],
      });
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
      });

      // Nothing picked and no workspace open: the first host.
      await expectPinnedUsage(page, ["31% Weekly"]);
      await usageItem(page).click();
      await expect(page.getByTestId(`usage-host-${primaryServerId}`)).toBeVisible();

      await hostFilter(page).click();
      await page.getByTestId(`usage-host-filter-item-${secondary.serverId}`).click();
      await expect(
        page.getByTestId(`usage-host-${secondary.serverId}`).getByText("12%"),
      ).toBeVisible({ timeout: 30_000 });
      await expect(hostFilter(page)).toContainText("Secondary box");
      await qaScreenshot(page, "usage-screen-picked-host");
      await expectPinnedUsage(page, ["12% Weekly"]);

      // The e2e seed resets the host list on every load, so reopening re-adds the second host.
      await addConnectedHostAndReload(page, {
        serverId: secondary.serverId,
        label: "Secondary box",
        port: secondary.port,
      });
      await expectPinnedUsage(page, ["12% Weekly"]);
      await expect(
        page.getByTestId(`usage-host-${secondary.serverId}`).getByText("12%"),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await secondary.close().catch(() => undefined);
    }
  });
});
