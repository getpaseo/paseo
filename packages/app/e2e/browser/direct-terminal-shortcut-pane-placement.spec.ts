import { expect, test } from "../support/fixtures";
import { runWorkspaceActionFromCommandCenter } from "../support/helpers/command-center-workspace-actions";
import { gotoWorkspace, pressDirectNewTabShortcut } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

test.describe("Direct terminal shortcut pane placement", () => {
  test("opens a terminal in the focused pane", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "direct-terminal-shortcut-pane-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      await runWorkspaceActionFromCommandCenter(page, "Split pane right");
      const focusedPaneChild = page
        .getByTestId("split-group-child")
        .filter({ has: page.getByTestId("workspace-new-tab-panel") });
      const originalPaneChild = page
        .getByTestId("split-group-child")
        .filter({ hasNot: page.getByTestId("workspace-new-tab-panel") });
      await expect(focusedPaneChild).toBeVisible();
      const focusedPaneId = await focusedPaneChild
        .locator('[data-testid^="workspace-pane-"]')
        .getAttribute("data-testid");
      const originalPaneId = await originalPaneChild
        .locator('[data-testid^="workspace-pane-"]')
        .getAttribute("data-testid");
      expect(focusedPaneId).not.toBeNull();
      expect(originalPaneId).not.toBeNull();
      const focusedPane = page.getByTestId(focusedPaneId!);
      const originalPane = page.getByTestId(originalPaneId!);

      await pressDirectNewTabShortcut(page, "t");

      await expect(focusedPane.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(1, {
        timeout: 30_000,
      });
      await expect(originalPane.locator('[data-testid^="workspace-tab-terminal_"]')).toHaveCount(0);
    } finally {
      await workspace.cleanup();
    }
  });
});
