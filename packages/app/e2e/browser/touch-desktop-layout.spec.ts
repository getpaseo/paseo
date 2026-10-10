import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";

// An unfolded foldable held upright: past the 600px where a touch browser gets the desktop
// layout, short of the 720px a mouse-driven window needs.
const UNFOLDED_FOLDABLE = { width: 690, height: 830 };

async function openAppShellWithProject(page: Page, repoPrefix: string) {
  const seeded = await seedWorkspace({ repoPrefix });
  await gotoAppShell(page);
  return {
    projectRow: page.locator('[data-testid^="sidebar-project-row-"]').first(),
    openMenu: page.getByRole("button", { name: "Open menu", exact: true }),
    cleanup: seeded.cleanup,
  };
}

test.describe("touch screen between the touch and mouse desktop widths", () => {
  test.use({ viewport: UNFOLDED_FOLDABLE, isMobile: true, hasTouch: true });

  test("shows the sidebar beside the content", async ({ page }) => {
    const shell = await openAppShellWithProject(page, "touch-desktop-layout-");
    try {
      await expect(shell.projectRow).toBeInViewport({ timeout: 60_000 });
      await expect(shell.openMenu).toHaveCount(0);
    } finally {
      await shell.cleanup();
    }
  });

  test("keeps the settings detail pane at its 400px target", async ({ page }) => {
    const shell = await openAppShellWithProject(page, "touch-desktop-settings-");
    try {
      await openSettings(page);
      const detailPane = page.getByTestId("settings-detail-pane");
      await expect(detailPane).toBeVisible();
      const box = await detailPane.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(400);
    } finally {
      await shell.cleanup();
    }
  });
});

test.describe("mouse-driven window of the same size", () => {
  test.use({ viewport: UNFOLDED_FOLDABLE });

  test("keeps the compact layout", async ({ page }) => {
    const shell = await openAppShellWithProject(page, "mouse-compact-layout-");
    try {
      await expect(shell.openMenu).toBeVisible({ timeout: 60_000 });
      await expect(shell.projectRow).not.toBeInViewport();
    } finally {
      await shell.cleanup();
    }
  });
});
