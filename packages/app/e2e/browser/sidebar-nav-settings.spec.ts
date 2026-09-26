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
import {
  dragNavigationDivider,
  expectLastNavigationItemReachable,
  expectNavigationGroupFoldedAway,
  expectNavigationGroupHeight,
  expectNavigationGroupScrollsWithinItsShare,
  expectNavigationGroupShowsItems,
  expectNavigationGroupTaller,
  expectStoredNavigationHeight,
  expectTouchNavigationDivider,
  navigationGroupHeight,
  toggleNavigationGroup,
  touchDragNavigationDivider,
} from "../support/helpers/sidebar-nav-group";

// Short enough that the group's share sits well under the rows' natural height, so the
// overflow assertion does not ride on a couple of pixels of row padding.
const SHORT_WINDOW = { width: 1200, height: 240 };

test.describe("Sidebar items in settings", () => {
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

test.describe("The sidebar items group", () => {
  test("owner folds the navigation group away and finds it folded next time", async ({ page }) => {
    await gotoAppShell(page);
    await expectNavigationGroupShowsItems(page);

    await toggleNavigationGroup(page);
    await expectNavigationGroupFoldedAway(page);

    await page.reload();
    await expectNavigationGroupFoldedAway(page);

    await toggleNavigationGroup(page);
    await expectNavigationGroupShowsItems(page);
  });

  test("navigation items scroll in place on a short window", async ({ page }) => {
    await page.setViewportSize(SHORT_WINDOW);
    await gotoAppShell(page);

    await expectNavigationGroupScrollsWithinItsShare(page, SHORT_WINDOW.height);
    await expectLastNavigationItemReachable(page);
  });

  test("owner drags the navigation group taller and finds it that tall next time", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await expectNavigationGroupShowsItems(page);

    const startHeight = await dragNavigationDivider(page, 0);
    await dragNavigationDivider(page, 80);
    await expectNavigationGroupTaller(page, startHeight);

    const stored = await expectStoredNavigationHeight(page);
    await page.reload();
    await expectNavigationGroupHeight(page, stored);
  });

  // A wide window with a coarse pointer: the desktop sidebar, driven by a finger.
  test.describe("on a touch screen", () => {
    test.use({ viewport: { width: 1200, height: 800 }, isMobile: true, hasTouch: true });

    test("owner drags the navigation group taller with a finger", async ({ page }) => {
      await gotoAppShell(page);
      await expectNavigationGroupShowsItems(page);
      await expectTouchNavigationDivider(page);

      const startHeight = await navigationGroupHeight(page);
      await touchDragNavigationDivider(page, 80);
      await expectNavigationGroupTaller(page, startHeight);

      const stored = await expectStoredNavigationHeight(page);
      await page.reload();
      await expectNavigationGroupHeight(page, stored);
    });
  });
});
