import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

// The shell keeps a compact copy of the sidebar mounted, so match the visible group only.
function navGroup(page: Page) {
  return page.locator('[data-testid="sidebar-nav-group"]:visible').first();
}

function navHeader(page: Page) {
  return navGroup(page).getByTestId("sidebar-nav-group-header");
}

function navRows(page: Page) {
  return navGroup(page).getByTestId("sidebar-nav-group-rows");
}

function newWorkspaceRow(page: Page) {
  return page.locator('[data-testid="sidebar-global-new-workspace"]:visible');
}

test.describe("Sidebar navigation group", () => {
  test("folds down to its header and stays folded after a reload", async ({ page }) => {
    await gotoAppShell(page);
    await expect(navHeader(page)).toBeVisible({ timeout: 30_000 });
    await expect(navHeader(page)).toHaveAttribute("aria-expanded", "true");
    await expect(newWorkspaceRow(page)).toHaveCount(1);

    await navHeader(page).click();
    await expect(navHeader(page)).toHaveAttribute("aria-expanded", "false");
    await expect(navRows(page)).toHaveCount(0);
    await expect(newWorkspaceRow(page)).toHaveCount(0);

    await page.reload();
    await expect(navHeader(page)).toBeVisible({ timeout: 30_000 });
    await expect(navHeader(page)).toHaveAttribute("aria-expanded", "false");
    await expect(newWorkspaceRow(page)).toHaveCount(0);

    await navHeader(page).click();
    await expect(navHeader(page)).toHaveAttribute("aria-expanded", "true");
    await expect(newWorkspaceRow(page)).toHaveCount(1);
  });

  test("caps its rows on a short window so the workspace list keeps its room", async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 360 });
    await gotoAppShell(page);
    await expect(navRows(page)).toBeVisible({ timeout: 30_000 });

    // A third of 360px holds fewer than the four built-in rows, so the group must scroll
    // rather than push the workspace list below the bottom of the sidebar.
    const rowsBox = await navRows(page).boundingBox();
    expect(rowsBox).not.toBeNull();
    expect(rowsBox!.height).toBeLessThanOrEqual(120);

    const overflow = await navRows(page).evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    expect(overflow.scrollHeight).toBeGreaterThan(overflow.clientHeight);

    const schedulesRow = page.locator('[data-testid="sidebar-schedules"]:visible').first();
    await schedulesRow.scrollIntoViewIfNeeded();
    const schedulesBox = await schedulesRow.boundingBox();
    expect(schedulesBox).not.toBeNull();
    expect(schedulesBox!.y + schedulesBox!.height).toBeLessThanOrEqual(
      rowsBox!.y + rowsBox!.height + 1,
    );
  });
});
