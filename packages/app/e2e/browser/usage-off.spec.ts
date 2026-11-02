import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedSidebarFooterPreferences } from "../support/helpers/sidebar-nav-settings";
import { installUsageReportsFixture } from "../support/helpers/usage-reports";
import {
  claudeAndCodexReports,
  openUsageFromIcon,
  openUsageOptions,
  closeUsageOptions,
  closeUsage,
  expectNoUsageItem,
  expectPinnedUsage,
} from "../support/helpers/usage-sidebar-item";

test("Check usage applies to the host and Turn on restores cards", async ({
  page,
  e2eWorkerClient,
}) => {
  test.setTimeout(180_000);
  const previous = (await e2eWorkerClient.getDaemonConfig()).config.usage ?? { enabled: true };
  try {
    const usage = await installUsageReportsFixture(page, {
      lists: [() => claudeAndCodexReports()],
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await seedSidebarFooterPreferences(page, [{ key: "usage", visible: true }]);
    await gotoAppShell(page);
    await expectPinnedUsage(page, ["31% 5h", "54% wk", "7% 5h", "12% wk"]);
    await openUsageFromIcon(page);
    await usage.waitForListRequests(1);
    await openUsageOptions(page);
    await page.getByRole("switch", { name: "Check usage", exact: true }).click();
    await closeUsageOptions(page);
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Refresh all", exact: true })).toHaveCount(0);
    expect((await e2eWorkerClient.getDaemonConfig()).config.usage).toEqual({ enabled: false });
    await expectNoUsageItem(page);
    const before = usage.listRequests().length;
    await closeUsage(page);
    await page.reload();
    await openUsageFromIcon(page);
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
    expect(usage.listRequests()).toHaveLength(before);
    await page.getByRole("button", { name: "Turn on", exact: true }).click();
    await expect(page.getByText("Claude", { exact: true })).toBeVisible();
    expect((await e2eWorkerClient.getDaemonConfig()).config.usage).toEqual({ enabled: true });
    // A separate client changes the policy, as another device would.
    await e2eWorkerClient.patchDaemonConfig({ usage: { enabled: false } });
    await expect(page.getByRole("button", { name: "Turn on", exact: true })).toBeVisible();
    await e2eWorkerClient.patchDaemonConfig({ usage: { enabled: true } });
    await expect(page.getByText("Claude", { exact: true })).toBeVisible();
  } finally {
    await e2eWorkerClient.patchDaemonConfig({ usage: previous });
  }
});

test("older hosts keep usage without a Check usage switch", async ({ page }) => {
  test.setTimeout(180_000);
  await installUsageReportsFixture(page, {
    usageSettingSupported: false,
    lists: [() => claudeAndCodexReports()],
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await gotoAppShell(page);
  await openUsageFromIcon(page);
  await expect(page.getByText("Claude", { exact: true })).toBeVisible();
  await openUsageOptions(page);
  await expect(page.getByRole("switch", { name: "Check usage", exact: true })).toHaveCount(0);
});
