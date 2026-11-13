import { expect, type Locator, type Page } from "@playwright/test";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { openAppearanceSettings } from "../support/helpers/content-width";
import { clickNewChat, clickNewTerminal, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

type TabPlacementOption = "Horizontal (top)" | "Vertical (left)";

const FOCUS_MODE_MODIFIER = process.platform === "darwin" ? "Meta" : "Control";

const TAB_SELECTOR =
  '[data-testid^="workspace-tab-"]:not([data-testid^="workspace-tab-context-"]):not([data-testid^="workspace-tab-switcher-"])';

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function panes(page: Page): Locator {
  return page.locator('[data-testid^="workspace-pane-"]').filter({ visible: true });
}

function tabColumns(page: Page): Locator {
  return visible(page, "workspace-tabs-column");
}

function tabsIn(rail: Locator): Locator {
  return rail.locator(TAB_SELECTOR).filter({ visible: true });
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Element is not laid out");
  return box;
}

async function boxesOf(locator: Locator): Promise<Awaited<ReturnType<typeof boxOf>>[]> {
  const boxes: Awaited<ReturnType<typeof boxOf>>[] = [];
  for (const element of await locator.all()) {
    boxes.push(await boxOf(element));
  }
  return boxes;
}

async function tabIdsIn(rail: Locator): Promise<string[]> {
  const ids: string[] = [];
  for (const tab of await tabsIn(rail).all()) {
    ids.push((await tab.getAttribute("data-testid")) ?? "");
  }
  return ids;
}

/** Seeds a workspace and opens it with three tabs in its one pane. */
async function openWorkspaceWithTabs(page: Page, repoPrefix: string): Promise<SeededWorkspace> {
  await page.setViewportSize({ width: 1600, height: 900 });
  const workspace = await seedWorkspace({ repoPrefix });
  await gotoWorkspace(page, workspace.workspaceId);
  await waitForWorkspaceTabsVisible(page);
  await clickNewChat(page);
  await clickNewTerminal(page);
  await clickNewChat(page);
  await expect(tabsIn(visible(page, "workspace-tabs-row"))).toHaveCount(3);
  return workspace;
}

async function chooseTabPlacement(page: Page, option: TabPlacementOption): Promise<void> {
  await openAppearanceSettings(page);
  await page.getByLabel(/^Tab placement:/).click();
  await page.getByRole("menuitem", { name: option, exact: true }).click();
  await expect(page.getByLabel(`Tab placement: ${option}`, { exact: true })).toBeVisible();
}

async function returnToWorkspace(page: Page, workspace: SeededWorkspace): Promise<void> {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspace.workspaceId));
}

async function openWorkspaceWithTabColumn(
  page: Page,
  repoPrefix: string,
): Promise<SeededWorkspace> {
  const workspace = await openWorkspaceWithTabs(page, repoPrefix);
  await chooseTabPlacement(page, "Vertical (left)");
  await returnToWorkspace(page, workspace);
  await expect(tabColumns(page)).toHaveCount(1);
  await expect(tabsIn(tabColumns(page))).toHaveCount(3);
  return workspace;
}

async function dragBy(handle: Locator, deltaX: number, deltaY: number): Promise<void> {
  const page = handle.page();
  const box = await boxOf(handle);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX / 2, y + deltaY / 2, { steps: 8 });
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 8 });
  await page.mouse.up();
}

async function columnWidth(page: Page): Promise<number> {
  return (await boxOf(tabColumns(page).first())).width;
}

async function centerY(locator: Locator): Promise<number> {
  const box = await boxOf(locator);
  return box.y + box.height / 2;
}

/**
 * Drags a tab up or down its column and drops it once the insertion indicator has settled on the
 * side of `neighbor` the drop is aimed at, the way a person waits to see where the tab will land.
 */
async function dragTabBeside(input: {
  tab: Locator;
  deltaY: number;
  neighbor: Locator;
  side: "above" | "below";
}): Promise<void> {
  const page = input.tab.page();
  const box = await boxOf(input.tab);
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const neighborY = await centerY(input.neighbor);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + input.deltaY / 2, { steps: 8 });
  await page.mouse.move(x, y + input.deltaY, { steps: 8 });
  const indicator = visible(page, "workspace-tabs-drop-indicator");
  await expect(indicator).toHaveCount(1);
  if (input.side === "below") {
    await expect.poll(() => centerY(indicator)).toBeGreaterThan(neighborY);
  } else {
    await expect.poll(() => centerY(indicator)).toBeLessThan(neighborY);
  }
  await page.mouse.up();
}

test.describe("Tab placement", () => {
  test("stacks a pane's tabs in a column on its left and returns them to the top", async ({
    page,
  }, testInfo) => {
    const workspace = await openWorkspaceWithTabs(page, "tab-placement-toggle-");
    try {
      await page.screenshot({ path: testInfo.outputPath("tabs-on-top.png") });

      await test.step("the setting moves the tabs into a column", async () => {
        await chooseTabPlacement(page, "Vertical (left)");
        await page.screenshot({ path: testInfo.outputPath("settings-tab-placement.png") });
        await returnToWorkspace(page, workspace);

        const column = tabColumns(page);
        await expect(column).toHaveCount(1);
        await expect(visible(page, "workspace-tabs-row")).toHaveCount(0);
        await expect(tabsIn(column)).toHaveCount(3);
        await expect(column.getByTestId("workspace-new-tab-button")).toBeVisible();

        const [first, second, third] = await boxesOf(tabsIn(column));
        expect(second.y).toBeGreaterThan(first.y + first.height - 1);
        expect(third.y).toBeGreaterThan(second.y + second.height - 1);
        expect(second.x).toBe(first.x);
        expect(second.width).toBe(first.width);

        const columnBox = await boxOf(column);
        const paneBox = await boxOf(panes(page).first());
        expect(columnBox.x).toBe(paneBox.x);
        expect(columnBox.width).toBeLessThan(paneBox.width / 2);
        await page.screenshot({ path: testInfo.outputPath("tabs-on-left.png") });
      });

      await test.step("a tab in the column opens on click", async () => {
        const firstTab = tabsIn(tabColumns(page)).first();
        await firstTab.click();
        await expect(firstTab).toHaveAttribute("aria-selected", "true");
      });

      await test.step("the setting returns the tabs to the top", async () => {
        await chooseTabPlacement(page, "Horizontal (top)");
        await returnToWorkspace(page, workspace);
        await expect(tabsIn(visible(page, "workspace-tabs-row"))).toHaveCount(3);
        await expect(tabColumns(page)).toHaveCount(0);
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("the column takes a dragged width, keeps it after a reload, and stops at its limits", async ({
    page,
  }, testInfo) => {
    const workspace = await openWorkspaceWithTabColumn(page, "tab-placement-resize-");
    try {
      const handle = visible(page, "workspace-tabs-column-resize-handle");
      const startWidth = await columnWidth(page);

      // The edge moves by the drag less the few pixels the gesture takes to commit to a resize.
      await dragBy(handle, 90, 0);
      await expect.poll(() => columnWidth(page)).toBeGreaterThan(startWidth + 60);
      const widened = await columnWidth(page);
      expect(widened).toBeLessThanOrEqual(startWidth + 90);
      await page.screenshot({ path: testInfo.outputPath("column-widened.png") });

      await page.reload();
      await expect(tabColumns(page)).toHaveCount(1);
      await expect.poll(() => columnWidth(page)).toBe(widened);

      await dragBy(handle, -600, 0);
      await expect.poll(() => columnWidth(page)).toBeLessThan(startWidth);
      const narrowest = await columnWidth(page);
      await dragBy(handle, -200, 0);
      await expect.poll(() => columnWidth(page)).toBe(narrowest);

      await dragBy(handle, 1200, 0);
      await expect.poll(() => columnWidth(page)).toBeGreaterThan(widened);
      const widest = await columnWidth(page);
      await dragBy(handle, 300, 0);
      await expect.poll(() => columnWidth(page)).toBe(widest);
    } finally {
      await workspace.cleanup();
    }
  });

  test("every split pane gets its own column at the shared width", async ({ page }, testInfo) => {
    const workspace = await openWorkspaceWithTabColumn(page, "tab-placement-split-");
    try {
      await runWorkspaceActionFromCommandCenter(page, "Split pane right");
      await expect(panes(page)).toHaveCount(2);
      await expect(tabColumns(page)).toHaveCount(2);

      for (const pane of await panes(page).all()) {
        const column = pane.getByTestId("workspace-tabs-column");
        await expect(column).toBeVisible();
        expect((await boxOf(column)).x).toBe((await boxOf(pane)).x);
      }
      const [left, right] = await boxesOf(tabColumns(page));
      expect(right.width).toBe(left.width);
      await page.screenshot({ path: testInfo.outputPath("split-panes.png") });
    } finally {
      await workspace.cleanup();
    }
  });

  test("a pane too narrow for its header swaps the column for the tab switcher", async ({
    page,
  }, testInfo) => {
    const workspace = await openWorkspaceWithTabColumn(page, "tab-placement-narrow-");
    try {
      await page.setViewportSize({ width: 760, height: 900 });
      await expect(tabColumns(page)).toHaveCount(0);
      await expect(visible(page, "workspace-tab-switcher-trigger")).toHaveCount(1);
      await page.screenshot({ path: testInfo.outputPath("narrow-pane.png") });

      await page.setViewportSize({ width: 1600, height: 900 });
      await expect(tabColumns(page)).toHaveCount(1);
      await expect(visible(page, "workspace-tab-switcher-trigger")).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });

  test("focus mode keeps the column and puts its exit control at the top", async ({
    page,
  }, testInfo) => {
    const workspace = await openWorkspaceWithTabColumn(page, "tab-placement-focus-");
    try {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(`${FOCUS_MODE_MODIFIER}+Shift+F`);

      const exitFocusMode = tabColumns(page).getByRole("button", { name: "Exit focus mode" });
      await expect(exitFocusMode).toBeVisible();
      await expect(tabsIn(tabColumns(page))).toHaveCount(3);
      await page.screenshot({ path: testInfo.outputPath("focus-mode.png") });

      await exitFocusMode.click();
      await expect(exitFocusMode).toHaveCount(0);
      await expect(tabsIn(tabColumns(page))).toHaveCount(3);
    } finally {
      await workspace.cleanup();
    }
  });

  test("tabs reorder by dragging up and down the column", async ({ page }, testInfo) => {
    const workspace = await openWorkspaceWithTabColumn(page, "tab-placement-reorder-");
    try {
      const column = tabColumns(page);
      const [first, second, third] = await tabIdsIn(column);
      const rowHeight =
        (await boxOf(tabsIn(column).nth(1))).y - (await boxOf(tabsIn(column).first())).y;

      await dragTabBeside({
        tab: tabsIn(column).first(),
        deltaY: rowHeight * 2.3,
        neighbor: tabsIn(column).nth(2),
        side: "below",
      });
      await expect.poll(() => tabIdsIn(column)).toEqual([second, third, first]);
      await page.screenshot({ path: testInfo.outputPath("reordered.png") });

      await dragTabBeside({
        tab: tabsIn(column).nth(2),
        deltaY: -rowHeight * 1.3,
        neighbor: tabsIn(column).nth(1),
        side: "above",
      });
      await expect.poll(() => tabIdsIn(column)).toEqual([second, first, third]);
    } finally {
      await workspace.cleanup();
    }
  });
});
