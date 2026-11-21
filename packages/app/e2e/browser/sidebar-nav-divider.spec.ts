import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

// A short window makes the top nav rows overflow a small share, so the scroll is observable.
test.use({ viewport: { width: 1100, height: 560 } });

interface SidebarMeasure {
  navHeight: number;
  navClientHeight: number;
  navScrollHeight: number;
  /** Everything below the divider to the window's bottom: the Workspaces list and the footer. */
  belowDividerHeight: number;
}

async function measureSidebar(page: Page): Promise<SidebarMeasure> {
  const nav = page.getByTestId("sidebar-nav-scroll");
  const divider = page.getByTestId("sidebar-nav-separator");
  const navBox = await nav.boundingBox();
  const dividerBox = await divider.boundingBox();
  const windowHeight = page.viewportSize()?.height;
  if (!navBox || !dividerBox || !windowHeight) throw new Error("sidebar is not laid out");
  const scroll = await nav.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  return {
    navHeight: navBox.height,
    navClientHeight: scroll.clientHeight,
    navScrollHeight: scroll.scrollHeight,
    belowDividerHeight: windowHeight - dividerBox.y,
  };
}

async function dragDivider(page: Page, deltaY: number) {
  const handle = page.getByTestId("sidebar-nav-separator").getByRole("separator");
  const box = await handle.boundingBox();
  if (!box) throw new Error("divider hit area is not laid out");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY / 2, { steps: 6 });
  await page.mouse.move(x, y + deltaY, { steps: 6 });
  await page.mouse.up();
}

async function storedNavShare(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("@paseo:app-settings");
    const parsed = raw ? (JSON.parse(raw) as { sidebarNavShare?: unknown }) : null;
    return typeof parsed?.sidebarNavShare === "number" ? parsed.sidebarNavShare : null;
  });
}

test("dragging the nav divider up gives the Workspaces list room, keeps the nav scrollable, and persists", async ({
  page,
}) => {
  await gotoAppShell(page);
  await expect(page.getByTestId("sidebar-nav-scroll")).toBeVisible({ timeout: 30_000 });

  const before = await measureSidebar(page);

  await dragDivider(page, -120);

  const after = await measureSidebar(page);
  expect(after.navHeight).toBeLessThan(before.navHeight - 40);
  // The footer is a constant, so the Workspaces list gains what the nav gave up.
  expect(after.belowDividerHeight).toBeGreaterThan(before.belowDividerHeight + 40);
  // The shrunk nav stays reachable by scrolling instead of folding rows into a menu.
  expect(after.navScrollHeight).toBeGreaterThan(after.navClientHeight);
  await expect.poll(() => storedNavShare(page)).toBeLessThan(0.5);
  const savedShare = await storedNavShare(page);

  await page.reload();
  await expect(page.getByTestId("sidebar-nav-scroll")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await measureSidebar(page)).navHeight)
    .toBeCloseTo(after.navHeight, -1);
  expect(await storedNavShare(page)).toBe(savedShare);
});
