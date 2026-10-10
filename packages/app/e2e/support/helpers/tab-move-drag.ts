import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Drag a tab chip onto a sidebar workspace row. The move affordances (the
 * floating label and the drop frame) are fixed overlays the drag hook appends
 * to `<body>`, so they are addressed by test id rather than through the tab
 * strip's tree.
 */

export const TAB_MOVE_GHOST_TESTID = "workspace-tab-move-ghost";
export const TAB_MOVE_HIGHLIGHT_TESTID = "workspace-tab-move-highlight";

const TAB_CHIP_PREFIX = "workspace-tab-";

/** A tab chip by its `data-testid` identity (e.g. `agent_<id>`). */
export function tabChip(page: Page, identity: string): Locator {
  return page
    .locator(`[data-testid="${TAB_CHIP_PREFIX}${identity}"]`)
    .filter({ visible: true })
    .first();
}

export function tabMoveGhost(page: Page): Locator {
  return page.getByTestId(TAB_MOVE_GHOST_TESTID);
}

export function tabMoveHighlight(page: Page): Locator {
  return page.getByTestId(TAB_MOVE_HIGHLIGHT_TESTID);
}

/** Neither affordance is offered: the pointer is not over a movable target. */
export async function expectNoTabMoveAffordances(page: Page): Promise<void> {
  await expect(tabMoveGhost(page)).toHaveCount(0);
  await expect(tabMoveHighlight(page)).toHaveCount(0);
}

/** Both affordances are offered, with the frame still alive after re-renders. */
export async function expectTabMoveAffordances(page: Page): Promise<void> {
  await expect(tabMoveGhost(page)).toBeVisible();
  await expect(tabMoveHighlight(page)).toBeVisible();
}

export interface TabMoveDrag {
  /** Travel along the strip, as if reordering tabs. */
  acrossStrip(distanceX: number): Promise<void>;
  /** Travel into the sidebar but away from the workspace rows. */
  ontoSidebarChrome(): Promise<void>;
  /** Travel onto a sidebar workspace row (the drop target). */
  ontoWorkspaceRow(workspaceKey: string): Promise<void>;
  /** Nudge inside the current target, forcing the sidebar to re-render. */
  nudge(): Promise<void>;
  /** Release the pointer. */
  drop(): Promise<void>;
}

/**
 * Press a tab chip and hold it, returning the drag controls. The pointer
 * travels in steps so the app sees a pointer drag rather than a jump.
 */
export async function beginTabMoveDrag(page: Page, chip: Locator): Promise<TabMoveDrag> {
  const box = await chip.boundingBox();
  if (!box) {
    throw new Error("tab chip has no box");
  }
  const origin = { x: box.x + 24, y: box.y + box.height / 2 };
  let current = origin;
  const moveTo = async (x: number, y: number, steps: number): Promise<void> => {
    await page.mouse.move(x, y, { steps });
    current = { x, y };
  };

  await page.mouse.move(origin.x, origin.y);
  await page.mouse.down();

  return {
    async acrossStrip(distanceX) {
      await moveTo(origin.x + distanceX, origin.y, 6);
    },
    async ontoSidebarChrome() {
      await moveTo(140, origin.y, 6);
    },
    async ontoWorkspaceRow(workspaceKey) {
      const row = page
        .locator(`[data-testid="sidebar-workspace-row-${workspaceKey}"]`)
        .filter({ visible: true })
        .first();
      await expect(row).toBeVisible({ timeout: 15_000 });
      const rowBox = await row.boundingBox();
      if (!rowBox) {
        throw new Error("workspace row has no box");
      }
      await moveTo(rowBox.x + 30, rowBox.y + rowBox.height / 2, 8);
    },
    async nudge() {
      await moveTo(current.x + 1, current.y + 1, 1);
    },
    async drop() {
      await page.mouse.up();
    },
  };
}

/** Press and hold the first visible tab chip, whatever kind it is. */
export function firstTabChip(page: Page): Locator {
  return page
    .locator(`[data-testid^="${TAB_CHIP_PREFIX}"]:not([data-testid^="${TAB_CHIP_PREFIX}context-"])`)
    .filter({ visible: true })
    .first();
}
