// Locks two behaviours that used to break together on web/desktop:
// 1) with the explorer pane focused, a newly appearing agent must auto-open into the
//    MAIN pane in the background — the explorer pane is a background surface and must
//    never swallow entity tabs or lose the user's focus, and
// 2) splitting a tab out of a pane leaves that pane empty, and the app must stay
//    interactive in the [agent | empty main | explorer] state (the reporter hit an
//    app-wide lockup here with no way to close the empty pane).
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { ensureExplorerPane, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function agentTabChip(page: Page, agentId: string): Locator {
  return visible(page, `workspace-tab-agent_${agentId}`);
}

function draftTabChip(page: Page): Locator {
  return page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true });
}

/** The explorer pane is the only tab row carrying the Changes tab. */
function explorerTabRow(page: Page): Locator {
  return visible(page, "workspace-tabs-row").filter({
    has: page.getByTestId("workspace-tab-working_diff"),
  });
}

function mainTabRow(page: Page): Locator {
  return visible(page, "workspace-tabs-row").filter({
    hasNot: page.getByTestId("workspace-tab-working_diff"),
  });
}

async function focusExplorerPane(page: Page): Promise<void> {
  await ensureExplorerPane(page);
  const changesTab = visible(page, "workspace-tab-working_diff").first();
  await changesTab.click({ position: { x: 12, y: 13 } });
  await expect(changesTab).toHaveAttribute("aria-selected", "true");
}

async function closeSeededDraftInMainPane(page: Page): Promise<void> {
  const chip = draftTabChip(page).first();
  await chip.hover();
  await page
    .locator('[data-testid^="workspace-draft-close-"]')
    .filter({ visible: true })
    .first()
    .click();
  await expect(draftTabChip(page)).toHaveCount(0, { timeout: 15_000 });
}

async function emptyPaneBox(page: Page) {
  const paneChild = page
    .getByTestId("split-group-child")
    .filter({ hasText: "No tabs in this pane." })
    .first();
  await expect(paneChild).toBeVisible({ timeout: 15_000 });
  const box = await paneChild.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Empty pane has no bounding box");
  return box;
}

async function paneBoxContainingChip(page: Page, chip: Locator) {
  const paneChild = page.getByTestId("split-group-child").filter({ has: chip }).first();
  await expect(paneChild).toBeVisible({ timeout: 15_000 });
  const box = await paneChild.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("Pane has no bounding box");
  return box;
}

/** dnd-kit pointer drag from a tab chip to an absolute point. */
async function dragChipTo(
  page: Page,
  chip: Locator,
  target: { x: number; y: number },
): Promise<void> {
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();
  if (!chipBox) throw new Error("Dragged chip has no bounding box");

  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  // Exceed the 8px PointerSensor activation distance before heading to the target.
  await page.mouse.move(chipBox.x + chipBox.width / 2 + 12, chipBox.y + chipBox.height / 2 + 4);
  await page.mouse.move(target.x, target.y, { steps: 20 });
  await page.mouse.up();
}

test.describe("explorer pane tab placement", () => {
  test("agents open in the main pane and empty-pane splits keep the app usable", async ({
    page,
  }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error)}`));

    const workspace = await seedWorkspace({ repoPrefix: "explorer-pane-placement-" });
    let agentId = "";

    try {
      await test.step("empty workspace seeds a draft in the main pane", async () => {
        await gotoWorkspace(page, workspace.workspaceId);
        await waitForWorkspaceTabsVisible(page);
        await expect(draftTabChip(page).first()).toBeVisible({ timeout: 30_000 });
      });

      await test.step("focus the explorer pane", async () => {
        await focusExplorerPane(page);
      });

      await test.step("an agent appearing now opens in the main pane, not the explorer pane", async () => {
        const agent = await workspace.client.createAgent({
          provider: "mock",
          cwd: workspace.repoPath,
          workspaceId: workspace.workspaceId,
          title: "Explorer Placement Agent",
          modeId: "load-test",
          model: "ten-second-stream",
          // Keep the agent streaming through the drag so pane contents are live,
          // matching the reporter's "spinners were still going" environment.
          initialPrompt: "stream please",
        });
        agentId = agent.id;
        await expect(agentTabChip(page, agentId).first()).toBeVisible({ timeout: 30_000 });

        await expect(
          mainTabRow(page).first().getByTestId(`workspace-tab-agent_${agentId}`),
        ).toBeVisible();
        await expect(
          explorerTabRow(page).first().getByTestId(`workspace-tab-agent_${agentId}`),
        ).toHaveCount(0);
        // The background open must not steal the explorer pane's focus.
        await expect(visible(page, "workspace-tab-working_diff").first()).toHaveAttribute(
          "aria-selected",
          "true",
        );
      });

      await test.step("close the draft; the agent is the main pane's only tab", async () => {
        await closeSeededDraftInMainPane(page);
        await expect(
          mainTabRow(page).first().locator('[data-testid^="workspace-tab-"]'),
        ).toHaveCount(1);
        await testInfo.attach("before-drag", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

      await test.step("split the agent out of the main pane, leaving it empty", async () => {
        const chip = agentTabChip(page, agentId).first();
        const mainBox = await paneBoxContainingChip(page, chip);
        // Land inside the left 15% edge band of the main pane content.
        await dragChipTo(page, chip, {
          x: mainBox.x + mainBox.width * 0.06,
          y: mainBox.y + mainBox.height * 0.6,
        });
        await testInfo.attach("after-split", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
        // The split must have taken: agent pane + empty main + explorer = 3 tab rows.
        await expect(visible(page, "workspace-tabs-row")).toHaveCount(3, { timeout: 10_000 });
        await expect(page.getByText("No tabs in this pane.")).toBeVisible();
      });

      await test.step("app must stay interactive after the split", async () => {
        // JS main thread alive?
        const pong = await page.evaluate("1 + 1");
        expect(pong).toBe(2);

        // Pointer interaction alive? Selecting the agent chip must still work.
        const chip = agentTabChip(page, agentId).first();
        await chip.click({ position: { x: 12, y: 13 }, timeout: 5_000 });
        await expect(chip).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

        // Clicking inside the empty pane (focuses it) must not lock anything.
        const emptyPane = page
          .getByTestId("split-group-child")
          .filter({ hasText: "No tabs in this pane." })
          .first();
        await emptyPane.click({ timeout: 5_000 });

        // The empty pane's + menu must open and dismiss cleanly.
        const emptyPaneTrigger = emptyPane.getByTestId("workspace-new-tab-menu-trigger").first();
        await emptyPaneTrigger.click({ timeout: 5_000 });
        await page.keyboard.press("Escape");

        // A second drag must work: center-drop the agent tab back into the empty pane.
        const target = await emptyPaneBox(page);
        await dragChipTo(page, chip, {
          x: target.x + target.width / 2,
          y: target.y + target.height / 2,
        });
        await testInfo.attach("after-center-drop", {
          body: await page.screenshot(),
          contentType: "image/png",
        });

        // The agent chip must have moved into the previously empty pane and stay clickable.
        await expect(page.getByText("No tabs in this pane.")).toHaveCount(0, { timeout: 10_000 });
        await agentTabChip(page, agentId)
          .first()
          .click({ position: { x: 12, y: 13 } });

        // The explorer toggle must still respond.
        await visible(page, "workspace-explorer-toggle").first().click({ timeout: 5_000 });
        await testInfo.attach("after-interactions", {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      });

      await testInfo.attach("console-errors", {
        body: JSON.stringify(consoleErrors, null, 2),
        contentType: "application/json",
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
