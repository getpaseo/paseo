import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";

test.describe("usage screen", () => {
  test("opens from the sidebar and groups reports under their host", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, {
      lists: [
        [
          {
            sourceId: "alpha",
            sourceLabel: "Alpha plan",
            report: {
              account: { key: "a" },
              status: "available",
              windows: [{ id: "weekly", label: "Weekly", usedPct: 31, headline: true }],
            },
          },
          {
            sourceId: "beta",
            sourceLabel: "Beta plan",
            report: { account: { key: "b" }, status: "unavailable", windows: [] },
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
    await expect(group.getByText("31%")).toBeVisible();
    await expect(group.getByText("Beta plan", { exact: true })).toBeVisible();
    await expect(group.getByText("Unavailable", { exact: true })).toBeVisible();
  });

  test("tells the user to update a host without usage sources", async ({ page }) => {
    test.setTimeout(120_000);
    const serverId = getServerId();
    const usage = await installUsageReportsFixture(page, { usageSources: false });

    await gotoAppShell(page);
    await page.locator('[data-testid="sidebar-usage"]:visible').first().click();

    await expect(
      page.getByTestId(`usage-host-${serverId}`).getByText("Update the host to see usage", {
        exact: true,
      }),
    ).toBeVisible({ timeout: 10_000 });
    expect(usage.listRequests()).toHaveLength(0);
  });
});
