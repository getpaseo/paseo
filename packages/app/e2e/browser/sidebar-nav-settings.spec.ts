import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectSidebarItemHidden,
  expectSidebarNavSettingsOrder,
  expectSidebarNavSettingsRow,
  expectSidebarOrder,
  expectStoredSidebarNav,
  leaveSettings,
  moveSidebarNavItemUp,
  openSidebarNavSettings,
  seedSidebarNavPreferences,
  setSidebarNavItemVisible,
} from "../support/helpers/sidebar-nav-settings";

test.describe("Sidebar items in Appearance settings", () => {
  test("owner reorders and hides top-level sidebar items", async ({ page }) => {
    await gotoAppShell(page);

    await test.step("the sidebar starts in the default order", async () => {
      await expectSidebarOrder(page, ["new-workspace", "history", "search", "schedules"]);
    });

    await test.step("the Sidebar section lists every item in the same order", async () => {
      await openSidebarNavSettings(page);
      // The section explains itself through the header's info tooltip, not a paragraph.
      await expect(page.getByTestId("sidebar-nav-section-info")).toHaveAccessibleName(
        "About Sidebar",
      );
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "history",
        "search",
        "schedules",
      ]);
      await expectSidebarNavSettingsRow(page, {
        key: "history",
        label: "History",
        visible: true,
      });
      // Items with a keyboard shortcut badge it next to their name. Chords render
      // with Ctrl off macOS, which is what the browser project runs on.
      await expect(
        page.getByTestId("sidebar-nav-item-new-workspace").getByText("Ctrl+N", { exact: true }),
      ).toBeVisible();
    });

    await test.step("moving Schedules up twice lifts it above History", async () => {
      await moveSidebarNavItemUp(page, "schedules");
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "history",
        "schedules",
        "search",
      ]);
      await moveSidebarNavItemUp(page, "schedules");
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "schedules",
        "history",
        "search",
      ]);

      await leaveSettings(page);
      await expectSidebarOrder(page, ["new-workspace", "schedules", "history", "search"]);
    });

    await test.step("turning History off removes it from the sidebar", async () => {
      await openSidebarNavSettings(page);
      await setSidebarNavItemVisible(page, "history", false);
      await expectStoredSidebarNav(page, [
        { key: "new-workspace", visible: true },
        { key: "schedules", visible: true },
        { key: "history", visible: false },
        { key: "search", visible: true },
      ]);

      await leaveSettings(page);
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "schedules", "search"]);
    });

    await test.step("the sidebar keeps that shape across a reload", async () => {
      await page.reload();
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "schedules", "search"]);
    });
  });

  test("renders no top-level items when every one is turned off", async ({ page }) => {
    await seedSidebarNavPreferences(page, [
      { key: "new-workspace", visible: false },
      { key: "history", visible: false },
      { key: "search", visible: false },
      { key: "schedules", visible: false },
    ]);
    await gotoAppShell(page);

    // The sidebar itself still renders; only its top-level nav items are gone.
    await expect(page.locator('[data-testid="sidebar-settings"]:visible')).toBeVisible({
      timeout: 30_000,
    });
    await expectSidebarItemHidden(page, "new-workspace");
    await expectSidebarItemHidden(page, "history");
    await expectSidebarItemHidden(page, "search");
    await expectSidebarItemHidden(page, "schedules");
  });
});
