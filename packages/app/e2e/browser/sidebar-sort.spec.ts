import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

const REHYDRATE_TIMEOUT = 30_000;

function projectRow(page: Page, projectViewKey: string): Locator {
  return page.locator(`[data-testid="sidebar-project-row-${projectViewKey}"]`).first();
}

async function projectRowOrder(page: Page, projectViewKeys: string[]): Promise<string[] | null> {
  const positions: Array<{ projectViewKey: string; y: number }> = [];
  for (const projectViewKey of projectViewKeys) {
    const box = await projectRow(page, projectViewKey).boundingBox();
    if (!box) return null;
    positions.push({ projectViewKey, y: box.y });
  }
  return positions.sort((a, b) => a.y - b.y).map((entry) => entry.projectViewKey);
}

async function expectProjectOrder(page: Page, projectViewKeys: string[], expected: string[]) {
  await expect
    .poll(() => projectRowOrder(page, projectViewKeys), { timeout: REHYDRATE_TIMEOUT })
    .toEqual(expected);
}

async function dragRowOnto(source: Locator, target: Locator): Promise<void> {
  await expect(source).toBeVisible({ timeout: REHYDRATE_TIMEOUT });
  await expect(target).toBeVisible({ timeout: REHYDRATE_TIMEOUT });
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Expected visible rows to drag");

  const page = source.page();
  const from = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const to = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 7);
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function selectSortMode(page: Page, mode: "manual" | "name" | "activity"): Promise<void> {
  const trigger = page.getByTestId("sidebar-display-preferences-menu");
  const sorting = page.getByTestId("sidebar-display-sorting");
  const item = page.getByTestId(`sidebar-sort-${mode}`);
  await expect(trigger).toBeVisible({ timeout: REHYDRATE_TIMEOUT });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await sorting.click();
  await expect(item).toBeVisible();
  await item.click();
}

test("sidebar Sort by: name overrides manual order, drag is gated to manual, and manual is restored", async ({
  page,
}) => {
  const alpha = await seedWorkspace({ repoPrefix: "sidebar-sort-alpha-" });
  const zeta = await seedWorkspace({ repoPrefix: "sidebar-sort-zeta-" });

  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const alphaViewKey = projectEquivalenceViewKey(alpha.projectKey);
    const zetaViewKey = projectEquivalenceViewKey(zeta.projectKey);
    const viewKeys = [alphaViewKey, zetaViewKey];
    const alphaRow = projectRow(page, alphaViewKey);
    const zetaRow = projectRow(page, zetaViewKey);

    await expectProjectOrder(page, viewKeys, [alphaViewKey, zetaViewKey]);

    await dragRowOnto(alphaRow, zetaRow);
    await expectProjectOrder(page, viewKeys, [zetaViewKey, alphaViewKey]);

    await selectSortMode(page, "name");
    await expectProjectOrder(page, viewKeys, [alphaViewKey, zetaViewKey]);

    await dragRowOnto(alphaRow, zetaRow);
    await expectProjectOrder(page, viewKeys, [alphaViewKey, zetaViewKey]);

    await selectSortMode(page, "manual");
    await expectProjectOrder(page, viewKeys, [zetaViewKey, alphaViewKey]);
  } finally {
    await alpha.cleanup();
    await zeta.cleanup();
  }
});
