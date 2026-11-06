import { existsSync } from "node:fs";
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
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

const UNDO_SHORTCUT = process.platform === "darwin" ? "Meta+Z" : "Control+Z";

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function archiveButton(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-archive-button-${getServerId()}:${workspaceId}`);
}

async function titleWidth(page: Page, workspaceId: string): Promise<number> {
  const box = await page
    .getByTestId(`sidebar-workspace-title-${getServerId()}:${workspaceId}`)
    .boundingBox();
  if (!box) throw new Error(`Title of ${workspaceId} is not laid out`);
  return box.width;
}

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

  async function activeWorkspaceIds(): Promise<string[]> {
    const { entries } = await client.fetchWorkspaces();
    return entries.map((entry) => entry.id);
  }

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
    const row = workspaceRow(page, worktree.workspaceId);

    await page.mouse.move(0, 0);
    await expect(archiveButton(page, worktree.workspaceId)).toHaveCount(0);
    const restingWidth = await titleWidth(page, worktree.workspaceId);

    await row.hover();
    await expect(archiveButton(page, worktree.workspaceId)).toBeVisible();
    await expect(page.getByTestId("sidebar-workspace-trailing-scrim")).toBeVisible();
    expect(await titleWidth(page, worktree.workspaceId)).toBe(restingWidth);

    const kebab = page.getByTestId(
      `sidebar-workspace-kebab-${getServerId()}:${worktree.workspaceId}`,
    );
    const [buttonBox, kebabBox] = await Promise.all([
      archiveButton(page, worktree.workspaceId).boundingBox(),
      kebab.boundingBox(),
    ]);
    expect(buttonBox && kebabBox && buttonBox.x + buttonBox.width <= kebabBox.x).toBe(true);
  });

  test("Cmd/Ctrl+Z right after archiving keeps the worktree", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-shortcut");

    page.once("dialog", (dialog) => void dialog.accept());
    await workspaceRow(page, worktree.workspaceId).hover();
    await archiveButton(page, worktree.workspaceId).click();
    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect(page.getByTestId("workspace-archived-toast-undo")).toBeVisible();

    await page.keyboard.press(UNDO_SHORTCUT);

    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
    await expect(page.getByTestId("workspace-archived-toast-undo")).toHaveCount(0);
    await expect.poll(activeWorkspaceIds).toContain(worktree.workspaceId);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);
    // A late remove from the canceled archive must not take the row back out.
    await page.waitForTimeout(1500);
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
  });

  test("Undo after the worktree was removed recreates it", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-recreate");

    page.once("dialog", (dialog) => void dialog.accept());
    await workspaceRow(page, worktree.workspaceId).hover();
    await archiveButton(page, worktree.workspaceId).click();
    const undo = page.getByTestId("workspace-archived-toast-undo");
    // Hovering the toast holds it, and with it the undo, open while the archive finishes.
    await undo.hover();
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    await undo.click();

    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(true);
  });

  test("Cmd/Ctrl+Z without an archive to undo leaves the sidebar alone", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-none");

    await page.keyboard.press(UNDO_SHORTCUT);

    await expect(page.getByTestId("workspace-archived-toast-undo")).toHaveCount(0);
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
  });
});
