import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

function visibleEmptyPane(page: Page): Locator {
  return page.getByTestId("workspace-pane-empty-state").filter({ visible: true });
}

async function expectLauncherSelection(launcher: Locator, name: string): Promise<void> {
  await expect(launcher.getByRole("button", { name })).toBeFocused();
}

async function openSidePanelWithKeyboard(page: Page): Promise<Locator> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+E`);
  const launcher = page
    .getByTestId("workspace-side-panel")
    .filter({ visible: true })
    .getByTestId("workspace-pane-empty-state");
  await expect(launcher).toBeVisible({ timeout: 30_000 });
  return launcher;
}

test.describe("Empty pane keyboard launcher", () => {
  test("Cmd+E focuses the launcher and Enter opens the selected view", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-pane-side-panel-keyboard-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      const launcher = await openSidePanelWithKeyboard(page);
      await expectLauncherSelection(launcher, "Changes");

      await page.keyboard.press("ArrowDown");
      await expectLauncherSelection(launcher, "Files");
      await page.keyboard.press("Enter");

      await expect(
        page
          .getByTestId("workspace-side-panel")
          .filter({ visible: true })
          .getByTestId("workspace-tab-files"),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("a new split pane focuses its launcher and wraps arrow navigation", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-pane-split-keyboard-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await runWorkspaceActionFromCommandCenter(page, "Split pane right");

      const launcher = visibleEmptyPane(page);
      await expect(launcher).toBeVisible({ timeout: 30_000 });
      await expectLauncherSelection(launcher, "Changes");

      await page.keyboard.press("ArrowUp");
      await expectLauncherSelection(launcher, "Terminal");
      await page.keyboard.press("ArrowDown");
      await expectLauncherSelection(launcher, "Changes");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");

      await expect(page.getByTestId("workspace-tab-files").filter({ visible: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
