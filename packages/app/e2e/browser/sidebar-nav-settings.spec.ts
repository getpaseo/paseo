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
      await expectSidebarOrder(page, ["new-workspace", "history", "search", "schedules", "teams"]);
    });

    await test.step("the Sidebar section lists every item in the same order", async () => {
      await openSidebarNavSettings(page);

      await expect(page.getByTestId("sidebar-nav-section-info")).toHaveAccessibleName(
        "About Sidebar",
      );
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "history",
        "search",
        "schedules",
        "teams",
      ]);
      await expectSidebarNavSettingsRow(page, {
        key: "history",
        label: "History",
        visible: true,
      });

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
        "teams",
      ]);
      await moveSidebarNavItemUp(page, "schedules");
      await expectSidebarNavSettingsOrder(page, [
        "new-workspace",
        "schedules",
        "history",
        "search",
        "teams",
      ]);

      await leaveSettings(page);
      await expectSidebarOrder(page, ["new-workspace", "schedules", "history", "search", "teams"]);
    });

    await test.step("turning History off removes it from the sidebar", async () => {
      await openSidebarNavSettings(page);
      await setSidebarNavItemVisible(page, "history", false);
      await expectStoredSidebarNav(page, [
        { key: "new-workspace", visible: true },
        { key: "schedules", visible: true },
        { key: "history", visible: false },
        { key: "search", visible: true },
        { key: "teams", visible: true },
      ]);

      await leaveSettings(page);
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "schedules", "search", "teams"]);
    });

    await test.step("the sidebar keeps that shape across a reload", async () => {
      await page.reload();
      await expectSidebarItemHidden(page, "history");
      await expectSidebarOrder(page, ["new-workspace", "schedules", "search", "teams"]);
    });
  });

  test("renders no top-level items when every one is turned off", async ({ page }) => {
    await seedSidebarNavPreferences(page, [
      { key: "new-workspace", visible: false },
      { key: "history", visible: false },
      { key: "search", visible: false },
      { key: "schedules", visible: false },
      { key: "teams", visible: false },
    ]);
    await gotoAppShell(page);

    await expect(page.locator('[data-testid="sidebar-settings"]:visible')).toBeVisible({
      timeout: 30_000,
    });
    await expectSidebarItemHidden(page, "new-workspace");
    await expectSidebarItemHidden(page, "history");
    await expectSidebarItemHidden(page, "search");
    await expectSidebarItemHidden(page, "schedules");
    await expectSidebarItemHidden(page, "teams");
  });
});
