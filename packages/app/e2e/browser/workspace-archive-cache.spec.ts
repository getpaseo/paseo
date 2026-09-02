import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { waitForWorkspaceInReplicaCache } from "../support/helpers/replica-cache-storage";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import {
  expectWorkspaceAbsentFromSidebar,
  selectWorkspaceInSidebar,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function archiveWorkspaceOutsideTheApp(workspace: SeededWorkspace): Promise<void> {
  const result = await workspace.client.archiveWorkspace(workspace.workspaceId);
  expect(result.error).toBeNull();
}

test.describe("Workspace archive cache coherence", () => {
  test("an archived selected workspace cannot return from the durable cache", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-cache-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectWorkspaceInSidebar(page, workspace.workspaceId);
      await waitForWorkspaceInReplicaCache(page, workspace.workspaceId);

      await archiveWorkspaceOutsideTheApp(workspace);

      await expectWorkspaceAbsentFromSidebar(page, workspace.workspaceId);
      await expect(page.getByText("Workspace unavailable", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
