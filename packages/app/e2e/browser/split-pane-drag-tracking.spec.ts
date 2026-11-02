import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { createCreationScenario } from "../support/helpers/creation";
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

async function dragDividerWithTouch(divider: Locator, deltaX: number): Promise<void> {
  const page = divider.page();
  const box = await divider.boundingBox();
  if (!box) throw new Error("Divider has no bounding box");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const input = await page.context().newCDPSession(page);
  try {
    await input.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await input.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (deltaX * step) / 8, y }],
      });
    }
    await input.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await input.detach();
  }
}

async function splitIntoFourPanes(page: Page): Promise<void> {
  for (const expectedDividers of [1, 2, 3]) {
    await runWorkspaceActionFromCommandCenter(page, "Split pane right");
    await expect(splitDividers(page)).toHaveCount(expectedDividers);
  }
}

async function expectDividersTrackPointer(
  page: Page,
  distance = DRAG_DISTANCE,
  drag = dragDivider,
): Promise<void> {
  for (const index of [0, 1, 2]) {
    const divider = splitDividers(page).nth(index);
    const before = await dividerX(divider);
    await drag(divider, distance);
    await expect
      .poll(async () => Math.abs((await dividerX(divider)) - before - distance), {
        message: `divider ${index + 1} should stay under the pointer`,
      })
      .toBeLessThanOrEqual(TOLERANCE_PX);
  }
}

for (const hasTouch of [false, true]) {
  test.describe(`Split pane drag tracking (${hasTouch ? "coarse" : "fine"} pointer)`, () => {
    test.use({ hasTouch });

    test("a divider moves as far as the pointer in the main row", async ({ page }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      const workspace = await seedWorkspace({ repoPrefix: "split-drag-tracking-" });
      try {
        await gotoWorkspace(page, workspace.workspaceId);
        await waitForWorkspaceTabsVisible(page);
        await clickNewChat(page);
        await splitIntoFourPanes(page);
        await expectDividersTrackPointer(
          page,
          DRAG_DISTANCE,
          hasTouch ? dragDividerWithTouch : dragDivider,
        );
      } finally {
        await workspace.cleanup();
      }
    });

    test("dividers track the pointer after app creation, Explorer changes and reload", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1600, height: 900 });
      const creation = await createCreationScenario(page);
      try {
        await creation.openWorkspaceForm("local");
        await creation.submitPrompt("Reply briefly.", "Create");
        await creation.expectAssistantReply();
        await waitForWorkspaceTabsVisible(page);
        await splitIntoFourPanes(page);
        await expectDividersTrackPointer(page);
        await page
          .getByTestId("workspace-explorer-toggle")
          .filter({ visible: true })
          .first()
          .click();
        await expect(page.getByTestId("workspace-explorer-sidebar")).toBeVisible();
        await expectDividersTrackPointer(page, -DRAG_DISTANCE);
        await page
          .getByTestId("workspace-explorer-toggle")
          .filter({ visible: true })
          .first()
          .click();
        await expect(page.getByTestId("workspace-explorer-sidebar")).not.toBeVisible();
        await page.reload();
        await expect(splitDividers(page)).toHaveCount(3);
        await expectDividersTrackPointer(page);
      } finally {
        await creation.cleanup();
      }
    });
  });
}
