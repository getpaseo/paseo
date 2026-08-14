import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { seedWorkspace } from "../support/helpers/seed-client";

const GROUP_BY_STATUS = "Group by status";
const GROUP_BY_PROJECT = "Group by project";

// Result rows carry no testID of their own, so the entries are addressed by their visible label.
async function runGroupingEntry(page: Page, label: string, absent: string): Promise<void> {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill("group");

  const entry = panel.getByText(label, { exact: true });
  await expect(entry).toBeVisible({ timeout: 30_000 });
  // The entry always names the mode you are not in, so its opposite must never be listed.
  await expect(panel.getByText(absent, { exact: true })).toHaveCount(0);

  await entry.click();
  await expect(page.getByTestId("command-center-panel")).not.toBeVisible({ timeout: 30_000 });
}

test.describe("Command center sidebar grouping", () => {
  test.describe.configure({ timeout: 120_000 });

  test("flips sidebar grouping and persists the choice across a reload", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "command-center-grouping-" });

    try {
      await gotoAppShell(page);
      const projectList = page.getByTestId("sidebar-project-workspace-list-scroll");
      const statusList = page.getByTestId("sidebar-status-list-scroll");
      await expect(projectList).toBeVisible({ timeout: 30_000 });

      // Query-only: the grouping entry stays out of the default empty-query list.
      const panel = await openCommandCenter(page);
      await expect(panel.getByText(GROUP_BY_STATUS, { exact: true })).toHaveCount(0);
      await expect(panel.getByText(GROUP_BY_PROJECT, { exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(panel).not.toBeVisible({ timeout: 30_000 });

      await runGroupingEntry(page, GROUP_BY_STATUS, GROUP_BY_PROJECT);
      await expect(statusList).toBeVisible({ timeout: 30_000 });
      await expect(projectList).toHaveCount(0);

      // The only assertion that catches a flip which never reached persisted storage.
      await page.reload();
      await expect(statusList).toBeVisible({ timeout: 30_000 });

      // Grouping persists, so the run must leave the sidebar back in project mode.
      await runGroupingEntry(page, GROUP_BY_PROJECT, GROUP_BY_STATUS);
      await expect(projectList).toBeVisible({ timeout: 30_000 });
      await expect(statusList).toHaveCount(0);
    } finally {
      await seeded.cleanup().catch(() => undefined);
    }
  });
});
