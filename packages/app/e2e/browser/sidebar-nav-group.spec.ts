import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
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

const SHORT_WINDOW = { width: 1200, height: 360 };

test.describe("Sidebar navigation group", () => {
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
