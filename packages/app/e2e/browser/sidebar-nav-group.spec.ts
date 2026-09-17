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
  toggleNavigationGroup,
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
});
