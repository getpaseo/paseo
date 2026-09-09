import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function firstProjectRowTop(page: Page): Promise<number | null> {
  return page
    .locator('[data-testid^="sidebar-project-row-"]')
    .first()
    .evaluate((el) => el.getBoundingClientRect().top)
    .catch(() => null);
}

test.describe("Sidebar header row shortcut reveal", () => {
  let workspace: SeededWorkspace;

  test.beforeEach(async () => {
    workspace = await seedWorkspace({ repoPrefix: "sidebar-shortcut-reveal-" });
  });

  test.afterEach(async () => {
    await workspace?.cleanup();
  });

  test("revealing the shortcut badge on hover keeps the row and the list below it in place", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const row = page.getByTestId("sidebar-global-new-workspace");
    const shortcut = row.getByTestId("sidebar-header-row-shortcut");
    await expect(row).toBeVisible();
    await expect(shortcut).toBeHidden();

    const rowBox = async () => {
      const box = await row.boundingBox();
      if (!box) throw new Error("sidebar header row has no bounding box");
      return box;
    };

    const beforeRow = await rowBox();
    const projectRowTop = await firstProjectRowTop(page);

    await row.hover();
    await expect(shortcut).toBeVisible();
    const hoveredRow = await rowBox();
    expect(Math.round(hoveredRow.height)).toBe(Math.round(beforeRow.height));
    expect(Math.round(hoveredRow.y)).toBe(Math.round(beforeRow.y));

    const hoveredProjectRowTop = await firstProjectRowTop(page);
    if (projectRowTop !== null && hoveredProjectRowTop !== null) {
      expect(Math.round(hoveredProjectRowTop)).toBe(Math.round(projectRowTop));
    }

    // Removing the badge must not move anything either.
    await page.mouse.move(0, 0);
    await expect(shortcut).toBeHidden();
    const restedRow = await rowBox();
    expect(Math.round(restedRow.height)).toBe(Math.round(beforeRow.height));
    expect(Math.round(restedRow.y)).toBe(Math.round(beforeRow.y));
  });
});
