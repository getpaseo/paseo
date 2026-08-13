import { test, expect } from "../support/fixtures";
import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";

/**
 * Covers the desktop sidebar collapse: the footer collapse button reduces the
 * sidebar to a minimal rail that only shows the expand button, and the expand
 * button restores the full sidebar.
 */
test("collapses the desktop sidebar to a minimal rail and expands it back", async ({ page }) => {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix: "sidebar-collapse-",
    title: "Sidebar collapse",
  });

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const collapseButton = page.getByTestId("sidebar-collapse");
    const expandButton = page.getByTestId("sidebar-expand");
    const newWorkspaceRow = page.getByTestId("sidebar-global-new-workspace");

    // Normalize to the expanded state: a prior test in this browser profile may
    // have persisted a collapsed sidebar.
    if (await expandButton.isVisible()) {
      await expandButton.click();
    }
    await expect(collapseButton).toBeVisible({ timeout: 30_000 });
    await expect(newWorkspaceRow).toBeVisible();

    // Collapse: only the expand button remains.
    await collapseButton.click();
    await expect(expandButton).toBeVisible();
    await expect(collapseButton).toBeHidden();
    await expect(newWorkspaceRow).toBeHidden();

    // Expand: the full sidebar returns.
    await expandButton.click();
    await expect(collapseButton).toBeVisible();
    await expect(newWorkspaceRow).toBeVisible();
    await expect(expandButton).toBeHidden();
  } finally {
    await workspace.cleanup();
  }
});
