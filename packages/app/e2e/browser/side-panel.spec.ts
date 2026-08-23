import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { ensureSidePanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function sidePanel(page: Page): Locator {
  return page.getByTestId("workspace-side-panel").filter({ visible: true });
}

function mainPane(page: Page): Locator {
  return page.getByTestId("workspace-pane-main").filter({ visible: true });
}

function newTabPanel(scope: Locator): Locator {
  return scope.getByTestId("workspace-new-tab-panel");
}

async function launcherButtonLabels(launcher: Locator): Promise<(string | null)[]> {
  return launcher
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")));
}

function sidePanelToggle(page: Page): Locator {
  return page.getByTestId("workspace-explorer-toggle").first();
}

/** Drags the pane's only tab into the left edge of its own pane, splitting it out. */
async function splitTabOutOfMainPane(page: Page, chip: Locator): Promise<void> {
  const paneBox = await mainPane(page).boundingBox();
  const chipBox = await chip.boundingBox();
  expect(paneBox).not.toBeNull();
  expect(chipBox).not.toBeNull();
  if (!paneBox || !chipBox) throw new Error("Unable to measure the main pane");

  await page.mouse.move(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(chipBox.x + chipBox.width / 2 + 12, chipBox.y + chipBox.height / 2 + 4);
  await page.mouse.move(paneBox.x + paneBox.width * 0.06, paneBox.y + paneBox.height * 0.6, {
    steps: 20,
  });
  await page.mouse.up();
}

test.describe("Side panel", () => {
  test("reveals empty, launches a view, and hides back out of the way", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "side-panel-reveal-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await expect(sidePanel(page)).toHaveCount(0);

      await test.step("revealing the Side panel seeds nothing", async () => {
        await sidePanelToggle(page).click();
        await expect(sidePanel(page)).toBeVisible({ timeout: 30_000 });
        const launcher = newTabPanel(sidePanel(page));
        await expect(launcher).toBeVisible();
        expect((await launcherButtonLabels(launcher)).slice(0, 4)).toEqual([
          "Changes",
          "Files",
          "Terminal",
          "Agent",
        ]);
        await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
        await capture(page, testInfo, "01-side-panel-reveals-empty");
      });

      await test.step("Changes opens in the Side panel that offered it", async () => {
        await newTabPanel(sidePanel(page)).getByRole("button", { name: "Changes" }).click();
        await expect(sidePanel(page).getByTestId("workspace-tab-working_diff")).toBeVisible({
          timeout: 30_000,
        });
        await expect(page.getByTestId("working-diff-panel").filter({ visible: true })).toBeVisible({
          timeout: 30_000,
        });
        await capture(page, testInfo, "02-changes-opens-in-side-panel");
      });

      await test.step("closing its final tab hides the Side panel, and it reopens empty", async () => {
        const changesTab = sidePanel(page).getByTestId("workspace-tab-working_diff");
        await changesTab.hover();
        await page
          .locator('[data-testid^="workspace-working-diff-close-"]')
          .filter({ visible: true })
          .click();
        await expect(sidePanel(page)).toHaveCount(0, { timeout: 15_000 });
        await capture(page, testInfo, "03-side-panel-hidden-after-final-tab-close");

        await sidePanelToggle(page).click();
        await expect(sidePanel(page)).toBeVisible({ timeout: 15_000 });
        await expect(newTabPanel(sidePanel(page))).toBeVisible();
        await capture(page, testInfo, "04-side-panel-revealed-empty");
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("an emptied ordinary pane is removed rather than hidden", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "side-panel-close-main-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await ensureSidePanel(page);

      // Dragging the pane's only tab into its own left edge splits that tab into a
      // new pane and leaves the one it came from empty.
      const draftTab = page
        .locator('[data-testid^="workspace-tab-draft_"]')
        .filter({ visible: true })
        .first();
      await expect(draftTab).toBeVisible({ timeout: 30_000 });
      await splitTabOutOfMainPane(page, draftTab);
      const draftPane = page
        .locator('[data-testid^="workspace-pane-pane_"]')
        .filter({ visible: true })
        .first();
      await expect(draftPane).toBeVisible({ timeout: 15_000 });

      const emptyMain = newTabPanel(mainPane(page));
      await expect(emptyMain).toBeVisible({ timeout: 15_000 });
      await capture(page, testInfo, "06-empty-main-pane-launcher");

      const newTabChip = mainPane(page)
        .locator('[data-testid^="workspace-tab-tab_"]')
        .filter({ hasText: "New tab" });
      await newTabChip.hover();
      await mainPane(page)
        .locator('[data-testid^="workspace-new-tab-close-"]')
        .filter({ visible: true })
        .click();

      // Gone for good, unlike the Side panel beside it, which is still only hidden away.
      await expect(mainPane(page)).toHaveCount(0, { timeout: 30_000 });
      await expect(sidePanel(page)).toBeVisible();
      await expect(draftPane.getByTestId("workspace-new-tab-panel")).toHaveCount(0);
      await capture(page, testInfo, "07-empty-main-pane-removed");
    } finally {
      await workspace.cleanup();
    }
  });

  test("closing New cannot remove the last visible pane", async ({ page }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "side-panel-final-pane-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      // Park a tab in the Side panel, then put the panel away. The workspace still
      // holds that tab, so emptying Main does not look like an empty workspace and
      // nothing reseeds a draft into it.
      await ensureSidePanel(page);
      await newTabPanel(sidePanel(page))
        .getByRole("button", { name: "Files", exact: true })
        .click();
      await expect(sidePanel(page).getByTestId("workspace-tab-files")).toBeVisible({
        timeout: 30_000,
      });
      await sidePanelToggle(page).click();
      await expect(sidePanel(page)).toHaveCount(0, { timeout: 15_000 });

      const draftTab = page
        .locator('[data-testid^="workspace-tab-draft_"]')
        .filter({ visible: true })
        .first();
      await draftTab.hover();
      await page
        .locator('[data-testid^="workspace-draft-close-"]')
        .filter({ visible: true })
        .first()
        .click();

      // Main now contains New and is the only pane the user can see. Closing its
      // tab cannot remove the final visible pane.
      const lastPane = newTabPanel(mainPane(page));
      await expect(lastPane).toBeVisible({ timeout: 15_000 });
      await expect(lastPane.getByRole("button", { name: "Files", exact: true })).toBeVisible();
      const finalNewTab = mainPane(page)
        .locator('[data-testid^="workspace-tab-tab_"]')
        .filter({ hasText: "New tab" });
      await finalNewTab.hover();
      await mainPane(page)
        .locator('[data-testid^="workspace-new-tab-close-"]')
        .filter({ visible: true })
        .click();
      await expect(lastPane).toBeVisible();
      await capture(page, testInfo, "08-final-visible-pane-has-no-close");
    } finally {
      await workspace.cleanup();
    }
  });

  test("a pane's own menu creates an independent view when one is open elsewhere", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "side-panel-claim-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await ensureSidePanel(page);
      await newTabPanel(sidePanel(page)).getByRole("button", { name: "Changes" }).click();
      await expect(sidePanel(page).getByTestId("workspace-tab-working_diff")).toBeVisible({
        timeout: 30_000,
      });
      await capture(page, testInfo, "08-changes-in-side-panel");

      await mainPane(page).getByTestId("workspace-new-tab-button").click();
      await page.getByTestId("workspace-new-tab-changes").filter({ visible: true }).first().click();

      await expect(mainPane(page).getByTestId("workspace-tab-working_diff")).toBeVisible({
        timeout: 15_000,
      });
      await expect(sidePanel(page).getByTestId("workspace-tab-working_diff")).toHaveCount(1);
      await expect(mainPane(page).getByTestId("workspace-tab-working_diff")).toHaveCount(1);
      await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(2);
      await capture(page, testInfo, "09-independent-changes-in-both-panes");
    } finally {
      await workspace.cleanup();
    }
  });
});
