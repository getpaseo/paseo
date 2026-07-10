import { test, expect } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed-client";

async function waitForSidebarWorkspace(page: import("@playwright/test").Page, workspaceId: string) {
  const row = page.getByTestId(`sidebar-workspace-row-${process.env.E2E_SERVER_ID}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function waitForSidebarProject(page: import("@playwright/test").Page, projectName: string) {
  const row = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: projectName })
    .first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

test.describe("Sidebar last-used sort", () => {
  test("clicking a workspace reorders projects by activity", async ({ page }) => {
    const workspaceA = await seedWorkspace({ repoPrefix: "last-used-a-" });
    const workspaceB = await seedWorkspace({ repoPrefix: "last-used-b-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, workspaceA.projectDisplayName);
      await waitForSidebarProject(page, workspaceB.projectDisplayName);

      // Switch sort to "Last used"
      const prefsTrigger = page.getByTestId("sidebar-display-preferences-menu").first();
      await expect(prefsTrigger).toBeVisible();
      await prefsTrigger.click();
      await page.getByTestId("sidebar-sort-activity").click();

      // Click workspace A and then B
      await waitForSidebarWorkspace(page, workspaceA.workspaceId);
      await page
        .getByTestId(`sidebar-workspace-row-${process.env.E2E_SERVER_ID}:${workspaceA.workspaceId}`)
        .click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

      await waitForSidebarWorkspace(page, workspaceB.workspaceId);
      await page
        .getByTestId(`sidebar-workspace-row-${process.env.E2E_SERVER_ID}:${workspaceB.workspaceId}`)
        .click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

      // The project for workspaceB should now be first
      const firstProject = page.locator('[data-testid^="sidebar-project-row-"]').first();
      await expect(firstProject).toContainText(workspaceB.projectDisplayName, { timeout: 10_000 });
    } finally {
      await workspaceA.cleanup();
      await workspaceB.cleanup();
    }
  });
});
