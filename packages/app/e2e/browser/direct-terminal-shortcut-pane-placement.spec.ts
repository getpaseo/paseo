import { expect, test } from "../support/fixtures";
import { gotoWorkspace, pressDirectNewTabShortcut } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openChangesPanel, waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

test.describe("Direct terminal shortcut pane placement", () => {
  test("opens a terminal in the focused pane", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "direct-terminal-shortcut-pane-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      await openChangesPanel(page);
      const focusedPane = page
        .getByTestId("workspace-tabs-row")
        .filter({ has: page.getByTestId("workspace-tab-working_diff") })
        .first();
      const primaryPane = page
        .getByTestId("workspace-tabs-row")
        .filter({ hasNot: page.getByTestId("workspace-tab-working_diff") })
        .first();
      await pressDirectNewTabShortcut(page, "t");

      await expect(focusedPane.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(primaryPane.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
