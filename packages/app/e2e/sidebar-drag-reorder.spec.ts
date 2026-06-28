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

async function openSortMenu(page: import("@playwright/test").Page) {
  const prefsTrigger = page.getByTestId("sidebar-display-preferences-menu").first();
  await expect(prefsTrigger).toBeVisible();
  await prefsTrigger.click();
}

test.describe("Sidebar drag reorder", () => {
  test("reordering projects persists", async ({ page }) => {
    const workspaceA = await seedWorkspace({ repoPrefix: "drag-a-" });
    const workspaceB = await seedWorkspace({ repoPrefix: "drag-b-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, workspaceA.projectDisplayName);
      await waitForSidebarProject(page, workspaceB.projectDisplayName);

      await openSortMenu(page);
      await page.getByTestId("sidebar-sort-custom").click();

      const firstProject = page.locator('[data-testid^="sidebar-project-row-"]').first();
      const secondProject = page.locator('[data-testid^="sidebar-project-row-"]').nth(1);
      await expect(firstProject).toContainText(workspaceA.projectDisplayName);
      await expect(secondProject).toContainText(workspaceB.projectDisplayName);

      const firstBox = await firstProject.boundingBox();
      const secondBox = await secondProject.boundingBox();
      if (!firstBox || !secondBox) throw new Error("missing project boxes");
      await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height + 8);
      await page.waitForTimeout(50);
      await page.mouse.up();

      await expect(page.locator('[data-testid^="sidebar-project-row-"]').first()).toContainText(
        workspaceB.projectDisplayName,
        { timeout: 10_000 },
      );
      await expect(page.locator('[data-testid^="sidebar-project-row-"]').nth(1)).toContainText(
        workspaceA.projectDisplayName,
        { timeout: 10_000 },
      );

      await page.reload();
      await waitForSidebarProject(page, workspaceA.projectDisplayName);
      await expect(page.locator('[data-testid^="sidebar-project-row-"]').first()).toContainText(
        workspaceB.projectDisplayName,
        { timeout: 30_000 },
      );
    } finally {
      await workspaceA.cleanup();
      await workspaceB.cleanup();
    }
  });

  test("reordering workspaces inside a project persists", async ({ page }) => {
    const sharedOrigin = `https://github.com/paseo-e2e/drag-ws-${Date.now()}.git`;
    const workspaceA = await seedWorkspace({
      repoPrefix: "drag-ws-a-",
      repo: { originUrl: sharedOrigin },
    });
    const workspaceB = await seedWorkspace({
      repoPrefix: "drag-ws-b-",
      repo: { originUrl: sharedOrigin },
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, workspaceA.projectDisplayName);

      await openSortMenu(page);
      await page.getByTestId("sidebar-sort-custom").click();

      const firstWs = await waitForSidebarWorkspace(page, workspaceA.workspaceId);
      const secondWs = await waitForSidebarWorkspace(page, workspaceB.workspaceId);

      const firstBox = await firstWs.boundingBox();
      const secondBox = await secondWs.boundingBox();
      if (!firstBox || !secondBox) throw new Error("missing workspace boxes");
      await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
      await page.mouse.down();
      await page.waitForTimeout(300);
      await page.mouse.move(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height + 8);
      await page.waitForTimeout(50);
      await page.mouse.up();

      await expect(
        page
          .locator('[data-testid^="sidebar-workspace-row-"]')
          .filter({ hasText: workspaceB.workspaceName })
          .first(),
      ).toBeVisible({ timeout: 10_000 });

      await page.reload();
      await waitForSidebarProject(page, workspaceA.projectDisplayName);
      await waitForSidebarWorkspace(page, workspaceB.workspaceId);
    } finally {
      await workspaceA.cleanup();
      await workspaceB.cleanup();
    }
  });
});
