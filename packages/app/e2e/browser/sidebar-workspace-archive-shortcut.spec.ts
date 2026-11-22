import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import {
  createGatedTeardown,
  pressArchiveShortcut,
  workspaceRow,
} from "../support/helpers/workspace-archive-undo";

// The archive shortcut used to be registered by the sidebar row itself, so it did nothing whenever
// the row was unmounted — a collapsed project section being the common case. It now lives in a
// single always-mounted handler keyed on the active route selection, like the pin shortcut.
// Returns the workspace route, so the test can assert archiving redirected off it.
async function openWorkspace(page: Page, workspaceId: string): Promise<string> {
  const row = workspaceRow(page, workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL((url) => url.pathname.endsWith(`/workspace/${workspaceId}`), {
    timeout: 30_000,
  });
  return page.url();
}

async function collapseProjectSection(page: Page, project: SeededWorkspace): Promise<void> {
  const header = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: project.projectDisplayName });
  await expect(header).toHaveCount(1, { timeout: 30_000 });

  await header.click();
  await expect(workspaceRow(page, project.workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

async function collapseStatusGroupContaining(page: Page, workspaceId: string): Promise<void> {
  const rows = page
    .locator('[data-testid^="sidebar-status-group-rows-"]')
    .filter({ has: workspaceRow(page, workspaceId) });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });

  const rowsTestId = await rows.getAttribute("data-testid");
  const bucket = rowsTestId?.replace("sidebar-status-group-rows-", "");
  expect(bucket).toBeTruthy();

  await page.getByTestId(`sidebar-status-group-${bucket}`).click();
  await expect(workspaceRow(page, workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

async function expectArchived(page: Page, workspace: SeededWorkspace, workspaceUrl: string) {
  await expect(page).not.toHaveURL(workspaceUrl);
  await expect
    .poll(async () => {
      const { entries } = await workspace.client.fetchWorkspaces();
      return entries.some((entry) => entry.id === workspace.workspaceId);
    })
    .toBe(false);
}

test.describe("Archive workspace shortcut", () => {
  test("archives the active workspace while its row is rendered", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-expanded-" });

    try {
      await gotoAppShell(page);
      const workspaceUrl = await openWorkspace(page, workspace.workspaceId);

      await pressArchiveShortcut(page);

      await expectArchived(page, workspace, workspaceUrl);
    } finally {
      await workspace.cleanup();
    }
  });

  test("archives the active workspace while its project section is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-collapsed-" });

    try {
      await gotoAppShell(page);
      const workspaceUrl = await openWorkspace(page, workspace.workspaceId);
      await collapseProjectSection(page, workspace);

      await pressArchiveShortcut(page);

      await expectArchived(page, workspace, workspaceUrl);
    } finally {
      await workspace.cleanup();
    }
  });

  test("archives the active workspace while its status group is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-status-" });

    try {
      await gotoAppShell(page);
      const workspaceUrl = await openWorkspace(page, workspace.workspaceId);
      await selectSidebarStatusGrouping(page);
      await expect(page.getByTestId("sidebar-status-list-scroll")).toBeVisible({
        timeout: 10_000,
      });
      await collapseStatusGroupContaining(page, workspace.workspaceId);

      await pressArchiveShortcut(page);

      await expectArchived(page, workspace, workspaceUrl);
    } finally {
      await workspace.cleanup();
    }
  });

  test("archives a different workspace while the first worktree is still tearing down", async ({
    page,
  }) => {
    const teardown = createGatedTeardown();
    const project = await seedWorkspace({
      repoPrefix: "archive-shortcut-teardown-",
      repo: { paseoConfig: teardown.paseoConfig },
    });
    const next = await seedWorkspace({ repoPrefix: "archive-shortcut-next-" });

    try {
      const { workspace: worktree, error } = await project.client.createWorkspace({
        source: {
          kind: "worktree",
          cwd: project.repoPath,
          worktreeSlug: "archive-shortcut-teardown",
        },
      });
      if (!worktree) throw new Error(error ?? "Could not seed the worktree");
      await gotoAppShell(page);

      await test.step("start the first archive and wait for its teardown", async () => {
        await openWorkspace(page, worktree.id);
        await pressArchiveShortcut(page);
        await teardown.expectStarted();
      });

      await test.step("archive the second workspace before the first archive finishes", async () => {
        const workspaceUrl = await openWorkspace(page, next.workspaceId);
        await pressArchiveShortcut(page);
        await expectArchived(page, next, workspaceUrl);
      });
    } finally {
      teardown.release();
      await project.cleanup();
      await next.cleanup();
    }
  });
});
