import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed-client";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

// Generous timeout so the poll rides out a transient WebSocket reconnect, during which the
// sidebar briefly shows "No projects yet" until it re-hydrates.
const REHYDRATE_TIMEOUT = 30_000;

function projectRow(page: Page, projectId: string): Locator {
  return page.locator(`[data-testid="sidebar-project-row-${projectId}"]`).first();
}

// Reports the given project ids ordered top-to-bottom by their sidebar row position, or null when
// any row is not currently mounted — so callers can poll through a transient empty sidebar.
async function projectRowOrder(page: Page, projectIds: string[]): Promise<string[] | null> {
  const positions: Array<{ projectId: string; y: number }> = [];
  for (const projectId of projectIds) {
    const box = await projectRow(page, projectId).boundingBox();
    if (!box) return null;
    positions.push({ projectId, y: box.y });
  }
  return positions.sort((a, b) => a.y - b.y).map((entry) => entry.projectId);
}

async function expectProjectOrder(page: Page, projectIds: string[], expected: string[]) {
  await expect
    .poll(() => projectRowOrder(page, projectIds), { timeout: REHYDRATE_TIMEOUT })
    .toEqual(expected);
}

// Immediate mouse drag from one row onto another (the activation nudge mirrors the drag-reorder
// spec so dnd-kit's movement threshold trips). Performs the gesture without asserting the result.
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

// Opens the display-preferences menu and picks a sort mode. Retries the open+click as a unit so a
// reconnect blip (which hides the gear until the sidebar re-hydrates) can't wedge the interaction;
// selecting a mode is idempotent, so retrying is safe.
async function selectSortMode(page: Page, mode: "manual" | "name" | "activity"): Promise<void> {
  const trigger = page.getByTestId("sidebar-display-preferences-menu");
  const item = page.getByTestId(`sidebar-sort-${mode}`);
  await expect(async () => {
    await expect(trigger).toBeVisible({ timeout: 10_000 });
    await trigger.click();
    await expect(item).toBeVisible({ timeout: 2_000 });
    await item.click();
  }).toPass({ timeout: REHYDRATE_TIMEOUT });
}

test("sidebar Sort by: name overrides manual order, drag is gated to manual, and manual is restored", async ({
  page,
}) => {
  // Distinct prefixes make the alphabetical (Name) order deterministic: alpha before zeta.
  const alpha = await seedWorkspace({ repoPrefix: "sidebar-sort-alpha-" });
  const zeta = await seedWorkspace({ repoPrefix: "sidebar-sort-zeta-" });

  try {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const ids = [alpha.projectId, zeta.projectId];
    const alphaRow = projectRow(page, alpha.projectId);
    const zetaRow = projectRow(page, zeta.projectId);

    // Default is manual mode with no saved drags: the base alphabetical order (alpha, zeta).
    await expectProjectOrder(page, ids, [alpha.projectId, zeta.projectId]);

    // Manual mode allows drag-to-reorder: move alpha below zeta and persist that order.
    await dragRowOnto(alphaRow, zetaRow);
    await expectProjectOrder(page, ids, [zeta.projectId, alpha.projectId]);

    // Switching to Name re-sorts alphabetically, ignoring the manual order.
    await selectSortMode(page, "name");
    await expectProjectOrder(page, ids, [alpha.projectId, zeta.projectId]);

    // Drag is disabled outside manual mode: attempting the same gesture changes nothing.
    await dragRowOnto(alphaRow, zetaRow);
    await expectProjectOrder(page, ids, [alpha.projectId, zeta.projectId]);

    // Returning to Manual restores the saved drag order — and proves the Name-mode drag above
    // never wrote to the persisted manual order.
    await selectSortMode(page, "manual");
    await expectProjectOrder(page, ids, [zeta.projectId, alpha.projectId]);
  } finally {
    await alpha.cleanup();
    await zeta.cleanup();
  }
});
