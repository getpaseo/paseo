import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { clickNewChat, gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const DRAG_DISTANCE = -40;

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
  await page.mouse.move(x + deltaX / 2, y, { steps: 4 });
  await page.mouse.move(x + deltaX, y, { steps: 4 });
  await page.mouse.up();
}

async function expectDividerFollowsDrag({
  page,
  index,
}: {
  page: Page;
  index: number;
}): Promise<void> {
  const divider = splitDividers(page).nth(index);
  const before = await dividerX(divider);
  await dragDivider(divider, DRAG_DISTANCE);
  await expect
    .poll(async () => (await dividerX(divider)) - before, {
      message: `divider ${index + 1} should follow the drag`,
    })
    .toBeLessThan(DRAG_DISTANCE * 0.75);
}

async function splitRight({
  page,
  expectedDividers,
}: {
  page: Page;
  expectedDividers: number;
}): Promise<void> {
  await runWorkspaceActionFromCommandCenter(page, "Split pane right");
  await expect(splitDividers(page)).toHaveCount(expectedDividers);
}

test.describe("Split pane resize", () => {
  test("every divider drags in a four-pane row", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const workspace = await seedWorkspace({ repoPrefix: "split-resize-fresh-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);
      await splitRight({ page, expectedDividers: 1 });
      await splitRight({ page, expectedDividers: 2 });
      await splitRight({ page, expectedDividers: 3 });

      for (const index of [0, 1, 2]) {
        await expectDividerFollowsDrag({ page, index });
      }
    } finally {
      await workspace.cleanup();
    }
  });

  test("every divider drags after panes are added to a resized row", async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const workspace = await seedWorkspace({ repoPrefix: "split-resize-grown-" });
    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);
      await splitRight({ page, expectedDividers: 1 });
      await expectDividerFollowsDrag({ page, index: 0 });

      await splitRight({ page, expectedDividers: 2 });
      await splitRight({ page, expectedDividers: 3 });

      for (const index of [0, 1, 2]) {
        await expectDividerFollowsDrag({ page, index });
      }
    } finally {
      await workspace.cleanup();
    }
  });
});
