import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed-client";
import { captureWsSessionFrames } from "./helpers/rename";
import { getServerId } from "./helpers/server-id";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function workspaceRenameModalTestId(workspaceId: string, suffix: string): string {
  return `sidebar-workspace-rename-modal-${getServerId()}:${workspaceId}-${suffix}`;
}

async function openRenameModal(page: Page, workspaceId: string) {
  const serverId = getServerId();
  const row = page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const renameItem = page.getByTestId(`sidebar-workspace-menu-rename-${serverId}:${workspaceId}`);
  await expect(renameItem).toBeVisible({ timeout: 10_000 });
  await renameItem.click();

  const input = page.getByTestId(workspaceRenameModalTestId(workspaceId, "input"));
  await expect(input).toBeVisible({ timeout: 10_000 });
  return input;
}

test.describe("Sidebar workspace rename", () => {
  test("renaming via kebab updates the branch name on disk and in the sidebar", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-rename-" });

    try {
      expect(workspace.workspaceName).toBe("main");

      const renameRequests = captureWsSessionFrames(
        page,
        "checkout.rename_branch.request",
        (inner) => ({
          branch: String(inner.branch ?? ""),
          cwd: String(inner.cwd ?? ""),
        }),
      );

      await gotoAppShell(page);
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      const input = await openRenameModal(page, workspace.workspaceId);
      await expect(input).toHaveValue("main");
      await input.fill("Feature Rename 2");

      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "submit")).click();

      await expect(input).toHaveCount(0, { timeout: 15_000 });
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        "feature-rename-2",
        { timeout: 15_000 },
      );

      expect(renameRequests.length).toBeGreaterThan(0);
      expect(renameRequests.at(-1)).toEqual({
        branch: "feature-rename-2",
        cwd: workspace.workspaceDirectory,
      });

      const currentBranchOnDisk = execSync("git branch --show-current", {
        cwd: workspace.repoPath,
        stdio: "pipe",
      })
        .toString()
        .trim();
      expect(currentBranchOnDisk).toBe("feature-rename-2");
    } finally {
      await workspace.cleanup();
    }
  });

  test("rename surfaces server errors inline and keeps the modal open", async ({ page }) => {
    const workspace = await seedWorkspace({
      repoPrefix: "sidebar-rename-error-",
      repo: { branches: ["taken"] },
    });

    try {
      await gotoAppShell(page);
      const input = await openRenameModal(page, workspace.workspaceId);
      await expect(input).toHaveValue("main");

      await input.fill("taken");
      await page.getByTestId(workspaceRenameModalTestId(workspace.workspaceId, "submit")).click();

      const errorNode = page.getByTestId(
        workspaceRenameModalTestId(workspace.workspaceId, "error"),
      );
      await expect(errorNode).toBeVisible({ timeout: 15_000 });
      await expect(errorNode).toContainText(/already exists|branch/i);
      await expect(input).toBeVisible();
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toContainText(
        "main",
      );
    } finally {
      await workspace.cleanup();
    }
  });
});
