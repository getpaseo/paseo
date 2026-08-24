import { expect, test, type Page } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const APP_SETTINGS_KEY = "@paseo:app-settings";
const CHANGES_SHORTCUT = `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`;

function mainPane(page: Page) {
  return page.getByTestId("workspace-pane-main").filter({ visible: true });
}

function sidePanel(page: Page) {
  return page.getByTestId("workspace-side-panel").filter({ visible: true });
}

test("Changes shortcut follows the default Side panel placement", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "changes-shortcut-side-" });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);

    await page.keyboard.press(CHANGES_SHORTCUT);

    await expect(sidePanel(page).getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(mainPane(page).getByTestId("workspace-tab-working_diff")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("Changes shortcut uses the focused pane when Side panel placement is off", async ({
  page,
}) => {
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ openSupportingTabsInSidePanel: false }));
  }, APP_SETTINGS_KEY);
  const workspace = await seedWorkspace({ repoPrefix: "changes-shortcut-pane-" });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);

    await page.keyboard.press(CHANGES_SHORTCUT);

    await expect(mainPane(page).getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(sidePanel(page)).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
