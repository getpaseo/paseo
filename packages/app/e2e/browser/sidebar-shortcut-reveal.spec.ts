import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

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
    const firstProjectRow = page.locator('[data-testid^="sidebar-project-row-"]').first();
    await expect(row).toBeVisible();
    await expect(firstProjectRow).toBeVisible();
    await expect(shortcut).toBeHidden();

    const rowGeometry = async () => {
      const box = await row.boundingBox();
      if (!box) throw new Error("sidebar header row has no bounding box");
      return { height: box.height, top: box.y };
    };
    const projectRowTop = async () => {
      const box = await firstProjectRow.boundingBox();
      if (!box) throw new Error("first project row has no bounding box");
      return box.y;
    };

    const beforeRow = await rowGeometry();
    const beforeProjectRowTop = await projectRowTop();

    await row.hover();
    await expect(shortcut).toBeVisible();
    const hoveredRow = await rowGeometry();
    const hoveredProjectRowTop = await projectRowTop();
    expect(Math.round(hoveredRow.height)).toBe(Math.round(beforeRow.height));
    expect(Math.round(hoveredRow.top)).toBe(Math.round(beforeRow.top));
    expect(Math.round(hoveredProjectRowTop)).toBe(Math.round(beforeProjectRowTop));

    // Removing the badge must not move anything either.
    await page.mouse.move(0, 0);
    await expect(shortcut).toBeHidden();
    const restedRow = await rowGeometry();
    expect(Math.round(restedRow.height)).toBe(Math.round(beforeRow.height));
    expect(Math.round(restedRow.top)).toBe(Math.round(beforeRow.top));
  });
});
