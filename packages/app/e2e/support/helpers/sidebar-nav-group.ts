import { expect, type Locator, type Page } from "@playwright/test";

// The shell keeps a compact copy of the sidebar mounted, so every lookup takes the
// visible group and reads the control by its role and name, as a person would.
function navGroup(page: Page): Locator {
  return page.locator('[data-testid="sidebar-nav-group"]:visible').first();
}

function navHeader(page: Page): Locator {
  return navGroup(page).getByRole("button", { name: "Navigation", exact: true });
}

function navRows(page: Page): Locator {
  return navGroup(page).getByTestId("sidebar-nav-group-rows");
}

export async function toggleNavigationGroup(page: Page): Promise<void> {
  await navHeader(page).click();
}

export async function expectNavigationGroupShowsItems(page: Page): Promise<void> {
  await expect(navHeader(page)).toBeVisible({ timeout: 30_000 });
  await expect(navHeader(page)).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("button", { name: "New workspace", exact: true }).first(),
  ).toBeVisible();
}

export async function expectNavigationGroupFoldedAway(page: Page): Promise<void> {
  await expect(navHeader(page)).toBeVisible({ timeout: 30_000 });
  await expect(navHeader(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator('[data-testid="sidebar-global-new-workspace"]:visible')).toHaveCount(0);
}

/** The group scrolls its own rows instead of growing past its share of the window. */
export async function expectNavigationGroupScrollsWithinItsShare(
  page: Page,
  viewportHeight: number,
): Promise<void> {
  await expect(navRows(page)).toBeVisible({ timeout: 30_000 });
  const rows = await navRows(page).evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  }));
  expect(rows.height).toBeLessThanOrEqual(Math.round(viewportHeight / 3));
  expect(rows.scrollHeight).toBeGreaterThan(rows.clientHeight);
}

/** The last item is reachable by scrolling, and never escapes the group to do it. */
export async function expectLastNavigationItemReachable(page: Page): Promise<void> {
  const lastItem = page.getByRole("button", { name: "Schedules", exact: true }).first();
  await lastItem.scrollIntoViewIfNeeded();
  const [itemBox, rowsBox] = await Promise.all([
    lastItem.boundingBox(),
    navRows(page).boundingBox(),
  ]);
  expect(itemBox).not.toBeNull();
  expect(rowsBox).not.toBeNull();
  expect(itemBox!.y + itemBox!.height).toBeLessThanOrEqual(rowsBox!.y + rowsBox!.height + 1);
}
