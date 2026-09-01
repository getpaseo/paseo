import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

const CHANGES_SHORTCUT = `${process.platform === "darwin" ? "Meta" : "Control"}+Shift+G`;

test("Changes shortcut reveals the Changes tree in Explorer", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "changes-shortcut-explorer-" });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    await waitForWorkspaceTabsVisible(page);

    await page.keyboard.press(CHANGES_SHORTCUT);

    const explorer = page.getByTestId("workspace-explorer-sidebar").filter({ visible: true });
    await expect(explorer.getByTestId("explorer-sidebar-tab-changes_tree")).toBeVisible({
      timeout: 30_000,
    });
    await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible();
    await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
