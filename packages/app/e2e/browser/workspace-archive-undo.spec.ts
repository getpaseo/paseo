import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { expectWorkspaceAbsentFromSidebar } from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  archiveFromRowButton,
  expectDirectoryPresence,
  expectHostWorkspaceSettledActive,
  outlastUndoWindow,
  pressUndoShortcut,
  rowArchiveButton,
  rowKebab,
  undoButton,
  workspaceRow,
  workspaceTitleWidth,
} from "../support/helpers/workspace-archive-undo";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

test.describe("Workspace archive undo", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const worktreeDirectories = new Set<string>();

  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("archive-undo-");
  });

  test.afterEach(async () => {
    for (const directory of worktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    worktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  async function seedWorktree(page: Page, slug: string) {
    await openProjectViaDaemon(client, tempRepo.path);
    const worktree = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `${slug}-${Date.now()}`,
    });
    worktreeDirectories.add(worktree.workspaceDirectory);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await waitForWorkspaceInSidebar(page, {
      serverId: getServerId(),
      workspaceId: worktree.workspaceId,
    });
    return worktree;
  }

  test("the hover archive button overlays the title instead of narrowing it", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-button-overlay");

    await page.mouse.move(0, 0);
    await expect(rowArchiveButton(page, worktree.workspaceId)).toHaveCount(0);
    const restingWidth = await workspaceTitleWidth(page, worktree.workspaceId);

    await workspaceRow(page, worktree.workspaceId).hover();
    await expect(rowArchiveButton(page, worktree.workspaceId)).toBeVisible();
    await expect(page.getByTestId("sidebar-workspace-trailing-scrim")).toBeVisible();
    expect(await workspaceTitleWidth(page, worktree.workspaceId)).toBe(restingWidth);

    const [buttonBox, kebabBox] = await Promise.all([
      rowArchiveButton(page, worktree.workspaceId).boundingBox(),
      rowKebab(page, worktree.workspaceId).boundingBox(),
    ]);
    expect(buttonBox && kebabBox && buttonBox.x + buttonBox.width <= kebabBox.x).toBe(true);
  });

  test("Cmd/Ctrl+Z right after archiving keeps the worktree", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-shortcut");

    await archiveFromRowButton(page, worktree.workspaceId);
    await pressUndoShortcut(page);

    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
    await expect(undoButton(page)).toHaveCount(0);
    await expectHostWorkspaceSettledActive(client, worktree.workspaceId);
    // Once the host settled, any remove the canceled archive sent has already arrived.
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
    await expectDirectoryPresence(worktree.workspaceDirectory, true);
  });

  test("Undo after the worktree was removed recreates it", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-recreate");

    await archiveFromRowButton(page, worktree.workspaceId);
    // Hovering the toast holds it, and with it the undo, open while the archive finishes.
    await undoButton(page).hover();
    await expectDirectoryPresence(worktree.workspaceDirectory, false);
    await undoButton(page).click();

    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible({ timeout: 30_000 });
    await expectDirectoryPresence(worktree.workspaceDirectory, true);
  });

  test("hovering Undo keeps the toast open past its deadline, and its close ends the undo", async ({
    page,
  }) => {
    await page.clock.install({ time: Date.now() });
    const worktree = await seedWorktree(page, "archive-undo-hold");

    await archiveFromRowButton(page, worktree.workspaceId);
    await page.getByTestId("workspace-archived-toast").hover({ position: { x: 8, y: 8 } });
    await undoButton(page).hover();
    await outlastUndoWindow(page);
    await expect(undoButton(page)).toBeVisible();

    await page.mouse.move(0, 0);
    await outlastUndoWindow(page);
    await expect(undoButton(page)).toHaveCount(0);

    // The toast took the undo with it.
    await pressUndoShortcut(page);
    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
  });

  test("Cmd/Ctrl+Z without an archive to undo leaves the sidebar alone", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-none");

    await pressUndoShortcut(page);

    await expect(undoButton(page)).toHaveCount(0);
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
  });
});
