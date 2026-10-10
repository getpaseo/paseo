import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const DRAG_DISTANCE = -40;
const TOLERANCE_PX = 2;

function splitDividers(page: Page): Locator {
  return page.getByTestId("workspace-split-resize-handle").filter({ visible: true });
}

async function dividerX(divider: Locator): Promise<number> {
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  return box.x;
}

async function dragDivider(divider: Locator, deltaX: number): Promise<void> {
  const page = divider.page();
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y, { steps: 8 });
  await page.mouse.up();
}

test.describe("Split pane drag tracking", () => {
  test("a divider moves as far as the mouse in the main row", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const workspace = await seedWorkspace({ repoPrefix: "split-drag-tracking-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);
      for (const expectedDividers of [1, 2, 3]) {
        await runWorkspaceActionFromCommandCenter(page, "Split pane right");
        await expect(splitDividers(page)).toHaveCount(expectedDividers);
      }

      for (const index of [0, 1, 2]) {
        const divider = splitDividers(page).nth(index);
        const before = await dividerX(divider);
        await dragDivider(divider, DRAG_DISTANCE);
        await expect
          .poll(async () => Math.abs((await dividerX(divider)) - before - DRAG_DISTANCE), {
            message: `divider ${index + 1} should stay under the mouse`,
          })
          .toBeLessThanOrEqual(TOLERANCE_PX);
      }
    } finally {
      await workspace.cleanup();
    }
  });
});
