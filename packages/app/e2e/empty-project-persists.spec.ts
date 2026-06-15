import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function hideWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  const serverId = getServerId();
  const row = page.getByTestId(workspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  // Hiding a checkout from the sidebar raises a browser confirm; accept it so the
  // user-confirmed archive proceeds deterministically.
  page.once("dialog", (dialog) => void dialog.accept());

  const archiveItem = page.getByTestId(`sidebar-workspace-menu-archive-${serverId}:${workspaceId}`);
  await expect(archiveItem).toBeVisible({ timeout: 10_000 });
  await archiveItem.click();
}

// Model B makes the project a first-class parent: archiving its last workspace
// must not delete the project. The per-project "+ New workspace" row is gone;
// the empty project keeps its parent row, and creation stays reachable from the
// project row's own new-worktree icon (git projects) and the global button.
test.describe("Empty project persists", () => {
  test("archiving the only workspace keeps the project row with creation still reachable", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-project-persists-" });

    try {
      const projectRow = page.getByTestId(`sidebar-project-row-${workspace.projectId}`);
      const projectNewWorktreeIcon = page.getByTestId(
        `sidebar-project-new-worktree-${workspace.projectId}`,
      );
      const globalNewWorkspace = page.getByTestId("sidebar-global-new-workspace");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      await hideWorkspaceFromSidebar(page, workspace.workspaceId);

      // The workspace row goes away, but its project parent stays as an empty
      // project row. Creation is still reachable: the project row keeps its own
      // new-worktree icon (revealed on hover) and the global button persists.
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(globalNewWorkspace).toBeVisible({ timeout: 30_000 });
      await projectRow.hover();
      await expect(projectNewWorktreeIcon).toBeVisible({ timeout: 30_000 });

      // The empty project survives a reload — it is persisted, not a transient
      // artifact of the just-archived workspace still lingering in memory.
      await page.reload();
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await projectRow.hover();
      await expect(projectNewWorktreeIcon).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
