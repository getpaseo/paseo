// Locks two behaviours that used to break together on web/desktop:
// 1) with the explorer pane focused, a newly appearing agent must auto-open into the
//    MAIN pane in the background — the explorer pane is a background surface and must
//    never swallow entity tabs or lose the user's focus, and
// 2) splitting a tab out of a pane leaves a New tab behind, and the app must stay
//    interactive in the [agent | New | explorer] state.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedCorruptedWorkspaceLayout } from "../support/helpers/workspace-layout";
import {
  openChangesTreePanel,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function agentTabChip(page: Page, agentId: string): Locator {
  return visible(page, `workspace-tab-agent_${agentId}`);
}

function draftTabChip(page: Page): Locator {
  return page.locator('[data-testid^="workspace-tab-draft_"]').filter({ visible: true });
}

/** The Explorer has its own fixed tab rail, separate from workspace pane rows. */
function explorerTabRow(page: Page): Locator {
  return visible(page, "explorer-sidebar-tab-rail");
}

function mainTabRow(page: Page): Locator {
  return visible(page, "workspace-tabs-row");
}

async function selectExplorerChanges(page: Page): Promise<void> {
  await openChangesTreePanel(page);
  await expect(visible(page, "changes-tree-panel").first()).toBeVisible();
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

function newTabPaneChild(page: Page): Locator {
  return page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId("workspace-new-tab-panel") })
    .first();
}

async function emptyPaneBox(page: Page) {
  const paneChild = newTabPaneChild(page);
  await expect(paneChild).toBeVisible({ timeout: 15_000 });
  const box = await paneChild.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("New tab pane has no bounding box");
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

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  return errors;
}

test.describe("explorer pane tab placement", () => {
  test("agents open in the main pane and New-tab splits keep the app usable", async ({
    page,
    withWorkspace,
    e2eWorkerClient,
  }, testInfo) => {
    const consoleErrors = collectConsoleErrors(page);

    const workspace = await withWorkspace({ prefix: "explorer-pane-placement-" });
    let agentId = "";

    await test.step("choose Agent from the empty workspace launcher", async () => {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await openAgentDraftFromLauncher(page);
      await expect(draftTabChip(page).first()).toBeVisible({ timeout: 30_000 });
    });

    await test.step("select Changes in Explorer", async () => {
      await selectExplorerChanges(page);
    });

    await test.step("an agent appearing now opens in the main pane, not the explorer pane", async () => {
      const agent = await e2eWorkerClient.createAgent({
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
      // The background open must not change the selected Explorer view.
      await expect(visible(page, "changes-tree-panel").first()).toBeVisible();
    });

    await test.step("close the draft; the agent is the main pane's only tab", async () => {
      await closeSeededDraftInMainPane(page);
      await expect(mainTabRow(page).first().locator('[data-testid^="workspace-tab-"]')).toHaveCount(
        1,
      );
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
      // The split must have taken: agent pane + New main. Explorer keeps its own rail.
      await expect(visible(page, "workspace-tabs-row")).toHaveCount(2, { timeout: 10_000 });
      await expect(explorerTabRow(page)).toHaveCount(1);
      await expect(page.getByTestId("workspace-new-tab-panel")).toBeVisible();
    });

    await test.step("app must stay interactive after the split", async () => {
      // JS main thread alive?
      const pong = await page.evaluate("1 + 1");
      expect(pong).toBe(2);

      // Pointer interaction alive? Selecting the agent chip must still work.
      const chip = agentTabChip(page, agentId).first();
      await chip.click({ position: { x: 12, y: 13 }, timeout: 5_000 });
      await expect(chip).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });

      // Clicking inside the New tab pane (focuses it) must not lock anything. Aim
      // above the vertically centred launcher, which would open a tab instead.
      const emptyPane = newTabPaneChild(page);
      await emptyPane.click({ position: { x: 40, y: 120 }, timeout: 5_000 });

      // A second drag must work: center-drop the agent tab back into the New pane.
      const target = await emptyPaneBox(page);
      await dragChipTo(page, chip, {
        x: target.x + target.width / 2,
        y: target.y + target.height / 2,
      });
      await testInfo.attach("after-center-drop", {
        body: await page.screenshot(),
        contentType: "image/png",
      });

      // The agent chip must have replaced New in that pane and stay clickable.
      await expect(page.getByTestId("workspace-new-tab-panel")).toHaveCount(0, {
        timeout: 10_000,
      });
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
  });
});

async function closeOnlyDraft(page: Page): Promise<void> {
  await draftTabChip(page).hover();
  await page.getByRole("button", { name: "Close", exact: true }).click();
}

async function moveOnlyDraftIntoRightSplit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Split pane right", exact: true }).click();
  const target = await emptyPaneBox(page);
  await dragChipTo(page, draftTabChip(page), {
    x: target.x + target.width / 2,
    y: target.y + target.height / 2,
  });
  await expect(visible(page, "workspace-tabs-row")).toHaveCount(1);
}

async function expectNewLauncher(page: Page): Promise<void> {
  await expect(
    page.getByTestId("workspace-new-tab-panel").getByRole("button", { name: "Agent", exact: true }),
  ).toBeVisible();
  await expect(draftTabChip(page)).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toHaveCount(0);
  await expect(page.getByText("Paseo ran into a problem.", { exact: true })).toHaveCount(0);
}

async function openAgentDraftFromLauncher(page: Page): Promise<void> {
  await expectNewLauncher(page);
  await page
    .getByTestId("workspace-new-tab-panel")
    .getByRole("button", { name: "Agent", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeVisible();
}

// Explorer cannot replace the ordinary workspace canvas, including on restore.
test("closing the last split-born tab with hidden Explorer keeps a usable workspace", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "last-pane-hidden-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await openAgentDraftFromLauncher(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await openAgentDraftFromLauncher(page);
  await moveOnlyDraftIntoRightSplit(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await page.reload();
  await expectNewLauncher(page);
});

test("visible Explorer does not replace the last ordinary workspace pane", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "last-pane-visible-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await page.getByRole("button", { name: "Open Explorer sidebar", exact: true }).click();
  await openAgentDraftFromLauncher(page);
  await moveOnlyDraftIntoRightSplit(page);
  await closeOnlyDraft(page);
  await expectNewLauncher(page);
  await page.reload();
  await expectNewLauncher(page);
});

test("reloading a saved hidden generated Explorer recovers a usable workspace", async ({
  page,
  withWorkspace,
}) => {
  const otherWorkspace = await withWorkspace({ prefix: "uncorrupted-explorer-" });
  await gotoWorkspace(page, otherWorkspace.workspaceId);
  await openAgentDraftFromLauncher(page);

  const workspace = await withWorkspace({ prefix: "saved-hidden-explorer-" });
  await gotoWorkspace(page, workspace.workspaceId);
  await expectNewLauncher(page);
  await seedCorruptedWorkspaceLayout(page, workspace.workspaceId);
  await page.reload();
  await expectNewLauncher(page);
  await gotoWorkspace(page, otherWorkspace.workspaceId);
  await expect(draftTabChip(page)).toHaveCount(1);
});
