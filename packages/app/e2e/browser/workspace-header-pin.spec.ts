import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// The workspace header's ⋯ menu pins and unpins the open workspace, so the user does not have to
// find its row in the sidebar first. It drives the same toggle as the sidebar row menu.

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function pinnedSection(page: Page) {
  return page.getByTestId("sidebar-pinned-section");
}

function headerPinItem(page: Page) {
  return page.getByTestId("workspace-header-pin");
}

async function openWorkspace(page: Page, workspaceId: string) {
  const row = workspaceRow(page, workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  // Park the pointer off the row so its hover card does not cover the screenshots.
  await page.mouse.move(800, 600);
}

// The menu and the sheet fade in; let them finish so the screenshot shows the settled menu.
// Only the evidence screenshots wait on this, never an assertion.
async function screenshotSettled(page: Page, path: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path });
}

async function openHeaderMenu(page: Page) {
  const trigger = page.getByTestId("workspace-header-menu-trigger");
  await expect(trigger).toBeVisible({ timeout: 10_000 });
  await trigger.click();
  await expect(headerPinItem(page)).toBeVisible({ timeout: 5_000 });
}

test.describe("Workspace header pin", () => {
  test("pins and unpins the open workspace from the header menu", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({
      repoPrefix: "header-pin-",
      title: "Header pin workspace",
    });

    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);
      await expect(pinnedSection(page)).toHaveCount(0);

      await test.step("pins from the menu", async () => {
        await openHeaderMenu(page);
        await expect(headerPinItem(page)).toHaveText("Pin workspace");
        await screenshotSettled(page, testInfo.outputPath("menu-pin.png"));

        await headerPinItem(page).click();
        await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });
        await expect(
          pinnedSection(page).getByTestId(
            `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
          ),
        ).toBeVisible();
        await screenshotSettled(page, testInfo.outputPath("sidebar-pinned.png"));
      });

      await test.step("offers Unpin once pinned, and unpinning restores the row", async () => {
        await openHeaderMenu(page);
        await expect(headerPinItem(page)).toHaveText("Unpin workspace");
        await screenshotSettled(page, testInfo.outputPath("menu-unpin.png"));

        await headerPinItem(page).click();
        await expect(pinnedSection(page)).toHaveCount(0, { timeout: 10_000 });
        await expect(workspaceRow(page, workspace.workspaceId)).toHaveCount(1);
        await screenshotSettled(page, testInfo.outputPath("sidebar-unpinned.png"));
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("pins from the compact header menu", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "header-pin-compact-" });

    try {
      await page.setViewportSize({ width: 1280, height: 900 });
      await gotoAppShell(page);
      await openWorkspace(page, workspace.workspaceId);

      await page.setViewportSize({ width: 400, height: 844 });
      await openHeaderMenu(page);
      await expect(headerPinItem(page)).toHaveText("Pin workspace");
      await screenshotSettled(page, testInfo.outputPath("compact-menu-pin.png"));
      await headerPinItem(page).click();

      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(pinnedSection(page)).toBeVisible({ timeout: 10_000 });
      await expect(
        pinnedSection(page).getByTestId(
          `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
        ),
      ).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });
});
