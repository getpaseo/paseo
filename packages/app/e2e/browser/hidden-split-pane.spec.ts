import { test, expect } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  expectExplorerNodeRetained,
  hideExplorerSplit,
  measureExplorerSplit,
  openExplorerSplit,
  resizeExplorerSplit,
  stampExplorerNode,
} from "../support/helpers/split-pane";
import {
  createAgentTabFromMenu,
  waitForWorkspaceTabsVisible,
} from "../support/helpers/workspace-tabs";

test.describe("Hidden split pane retention", () => {
  test("releases all layout space without unmounting and restores its dragged width", async ({
    page,
  }, testInfo) => {
    const workspace = await seedWorkspace({ repoPrefix: "hidden-split-pane-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);
      await createAgentTabFromMenu(page);
      await openExplorerSplit(page);

      // Drag to a non-default width first: restoring the default would prove nothing.
      await resizeExplorerSplit(page, 137);
      await stampExplorerNode(page);
      const open = await measureExplorerSplit(page);
      expect(open.explorerWidth).toBeGreaterThan(250);
      expect(open.separatorCount).toBe(1);

      await hideExplorerSplit(page);
      const hidden = await measureExplorerSplit(page);
      expect(hidden.explorerWidth).toBe(0);
      // The sibling must absorb the whole row, not just collapse the hidden pane.
      expect(hidden.visibleWidth).toBeCloseTo(hidden.containerWidth, 5);
      expect(hidden.occupiedWidth).toBeCloseTo(hidden.containerWidth, 5);
      expect(hidden.separatorCount).toBe(0);
      // Same DOM node, so a teardown-and-rebuild cannot pass as retention.
      await expectExplorerNodeRetained(page);

      await openExplorerSplit(page);
      await expectExplorerNodeRetained(page);
      const reopened = await measureExplorerSplit(page);
      expect(reopened.explorerWidth).toBeCloseTo(open.explorerWidth, 5);
      expect(reopened.separatorCount).toBe(1);

      await testInfo.attach("split-pane-geometry", {
        body: JSON.stringify({ open, hidden, reopened }, null, 2),
        contentType: "application/json",
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
