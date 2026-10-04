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

export async function navigationGroupHeight(page: Page): Promise<number> {
  const box = await navRows(page).boundingBox();
  expect(box).not.toBeNull();
  return box!.height;
}

/** The touch build offers a grab strip rather than the fine pointer's hairline. */
export async function expectTouchNavigationDivider(page: Page): Promise<void> {
  const divider = navDivider(page);
  await expect(divider).toBeVisible({ timeout: 30_000 });
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.height).toBeGreaterThan(10);
}

async function navDividerCentre(page: Page): Promise<{ x: number; y: number }> {
  const divider = navDivider(page);
  await expect(divider).toBeVisible({ timeout: 30_000 });
  const box = await divider.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** Drags the divider by `offset` points and answers the height the group ends up at. */
export async function dragNavigationDivider(page: Page, offset: number): Promise<number> {
  const { x, y } = await navDividerCentre(page);
  await page.mouse.move(x, y);
  await page.mouse.down();
  // Several steps: a single jump is one pointermove, which some drag implementations drop.
  await page.mouse.move(x, y + offset, { steps: 10 });
  await page.mouse.up();
  // The release is observable in the store, so wait for that instead of for a delay.
  await expect.poll(() => storedNavigationHeight(page)).not.toBeNull();
  return navigationGroupHeight(page);
}

/** The same drag as a finger makes it: the touch build's Pan sees touch events only. */
export async function touchDragNavigationDivider(page: Page, offset: number): Promise<void> {
  const { x, y } = await navDividerCentre(page);
  const steps = 10;
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= steps; step += 1) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + (offset * step) / steps }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach();
  }
}

export async function expectNavigationGroupTaller(
  page: Page,
  previousHeight: number,
): Promise<void> {
  await expect.poll(() => navigationGroupHeight(page)).toBeGreaterThan(previousHeight);
}

function storedNavigationHeight(page: Page): Promise<number | null> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return (
      (JSON.parse(raw) as { state?: { sidebarNavHeight?: number | null } }).state
        ?.sidebarNavHeight ?? null
    );
  }, PANEL_STATE_KEY);
}

export async function expectStoredNavigationHeight(page: Page): Promise<number> {
  await expect.poll(() => storedNavigationHeight(page)).not.toBeNull();
  return (await storedNavigationHeight(page)) as number;
}

export async function expectNavigationGroupHeight(page: Page, height: number): Promise<void> {
  await expect.poll(() => navigationGroupHeight(page)).toBeCloseTo(height, 0);
}
