import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  expectLastNavigationItemReachable,
  expectNavigationGroupFoldedAway,
  expectNavigationGroupScrollsWithinItsShare,
  expectNavigationGroupShowsItems,
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
});
