import { expect, type Locator, type Page } from "@playwright/test";

const PANEL_STATE_KEY = "panel-state";

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

function navDivider(page: Page): Locator {
  return navGroup(page).getByRole("separator", { name: "Resize navigation" });
}

async function navRowsHeight(page: Page): Promise<number> {
  const box = await navRows(page).boundingBox();
  expect(box).not.toBeNull();
  return box!.height;
}

/** Drags the divider by `offset` points and answers the height the group ends up at. */
export async function dragNavigationDivider(page: Page, offset: number): Promise<number> {
  const divider = navDivider(page);
  await expect(divider).toBeVisible({ timeout: 30_000 });
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Several steps: a single jump is one pointermove, which some drag implementations drop.
  await page.mouse.move(x, y + offset, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  return navRowsHeight(page);
}

export async function expectNavigationGroupTaller(
  page: Page,
  previousHeight: number,
): Promise<void> {
  await expect.poll(() => navRowsHeight(page)).toBeGreaterThan(previousHeight);
}

export async function expectStoredNavigationHeight(page: Page): Promise<number> {
  const stored = await page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return (
      (JSON.parse(raw) as { state?: { sidebarNavHeight?: number | null } }).state
        ?.sidebarNavHeight ?? null
    );
  }, PANEL_STATE_KEY);
  expect(stored).not.toBeNull();
  return stored as number;
}

export async function expectNavigationGroupHeight(page: Page, height: number): Promise<void> {
  await expect.poll(() => navRowsHeight(page)).toBeCloseTo(height, 0);
}
