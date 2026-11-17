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
import { createMockIdleAgent, openWorkspaceWithAgents } from "../support/helpers/archive-tab";
import { connectSeedClient } from "../support/helpers/seed-client";
import { createTempGitRepo } from "../support/helpers/workspace";
import { getWorkspaceTabTestIds } from "../support/helpers/workspace-tabs";
import {
  archivedToast,
  archiveFromRowButton,
  createGatedTeardown,
  expectDirectoryPresence,
  expectHostWorkspaceSettledActive,
  holdNextArchiveRequest,
  outlastUndoWindow,
  pressArchiveShortcut,
  pressUndoShortcut,
  resizeSidebarToMinimum,
  rowArchiveButton,
  rowKebab,
  scrollSidebarListToEnd,
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
    if (!buttonBox || !kebabBox) throw new Error("Row actions are not laid out");
    expect(kebabBox.x - (buttonBox.x + buttonBox.width)).toBeGreaterThanOrEqual(8);
  });

  test("the archived toast sits over the sidebar above its footer, and only Undo presses", async ({
    page,
  }) => {
    const worktree = await seedWorktree(page, "archive-toast-sidebar");

    await archiveFromRowButton(page, worktree.workspaceId);

    const [toastBox, footerBox] = await Promise.all([
      page.getByTestId("workspace-archived-toast").boundingBox(),
      page.getByTestId("sidebar-footer").boundingBox(),
    ]);
    if (!toastBox || !footerBox) throw new Error("Toast or footer is not laid out");
    expect(toastBox.x).toBeGreaterThanOrEqual(footerBox.x);
    expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(footerBox.x + footerBox.width);
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(footerBox.y);
    expect(footerBox.y - (toastBox.y + toastBox.height)).toBeLessThanOrEqual(16);

    await expect(page.getByTestId("app-toast-message")).toHaveCSS("cursor", "auto");
    await expect(undoButton(page)).toHaveCSS("cursor", "pointer");

    const [labelBox, shortcutBox] = await Promise.all([
      undoButton(page).getByText("Undo", { exact: true }).boundingBox(),
      undoButton(page).getByText(/Z$/).boundingBox(),
    ]);
    if (!labelBox || !shortcutBox) throw new Error("Undo button is not laid out");
    expect(shortcutBox.x - (labelBox.x + labelBox.width)).toBeLessThanOrEqual(8.5);
  });

  test("a long list ends just below its last row, and the toast over it moves no row", async ({
    page,
  }) => {
    await page.clock.install({ time: Date.now() });
    const fillers: Array<{ path: string; cleanup: () => Promise<void> }> = [];
    const fillerProjectIds: string[] = [];
    try {
      for (let index = 0; index < 10; index += 1) {
        const repo = await createTempGitRepo(`archive-toast-filler-${index}-`);
        fillers.push(repo);
        fillerProjectIds.push((await openProjectViaDaemon(client, repo.path)).projectId);
      }
      const worktree = await seedWorktree(page, "archive-toast-long-list");

      const resting = await scrollSidebarListToEnd(page);
      expect(resting.listBottom - resting.rowBottoms.at(-1)!).toBeLessThan(resting.rowHeight);

      await archiveFromRowButton(page, worktree.workspaceId);
      await page.mouse.move(0, 0);
      const withToast = await scrollSidebarListToEnd(page);
      const toastBox = await archivedToast(page).boundingBox();
      if (!toastBox) throw new Error("Toast is not laid out");
      expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(withToast.listBottom);

      await outlastUndoWindow(page);
      await expect(archivedToast(page)).toHaveCount(0);
      expect(await scrollSidebarListToEnd(page)).toEqual(withToast);
    } finally {
      for (const projectId of fillerProjectIds) {
        await client.removeProject(projectId).catch(() => undefined);
      }
      for (const repo of fillers) await repo.cleanup().catch(() => undefined);
    }
  });

  test("an archive that fails after the sidebar was replaced still shows its error", async ({
    page,
  }) => {
    const archive = await holdNextArchiveRequest(page);
    const worktree = await seedWorktree(page, "archive-late-failure");

    await archiveFromRowButton(page, worktree.workspaceId);
    await archive.waitForHeld();
    // Crossing the compact breakpoint swaps the sidebar, unmounting the toast's host.
    await page.setViewportSize({ width: 400, height: 720 });
    await expect(undoButton(page)).toHaveCount(0);

    archive.releaseForUnknownWorkspace("workspace-the-daemon-never-had");

    await expect(page.getByTestId("app-toast-message")).toHaveText(
      "Workspace not found: workspace-the-daemon-never-had",
    );
  });

  test("the archived toast keeps Undo inside the card at the narrowest sidebar", async ({
    page,
  }) => {
    const worktree = await seedWorktree(page, "archive-toast-narrow");
    await resizeSidebarToMinimum(page);

    await archiveFromRowButton(page, worktree.workspaceId);

    const [toastBox, undoBox] = await Promise.all([
      page.getByTestId("workspace-archived-toast").boundingBox(),
      undoButton(page).boundingBox(),
    ]);
    if (!toastBox || !undoBox) throw new Error("Toast is not laid out");
    expect(undoBox.x + undoBox.width).toBeLessThanOrEqual(toastBox.x + toastBox.width);
    expect(undoBox.y + undoBox.height).toBeLessThanOrEqual(toastBox.y + toastBox.height);
  });

  test("archiving by shortcut with the sidebar collapsed shows the toast over the app", async ({
    page,
  }) => {
    const worktree = await seedWorktree(page, "archive-toast-collapsed");
    await workspaceRow(page, worktree.workspaceId).click();
    await page.keyboard.press("ControlOrMeta+b");
    await expect(workspaceRow(page, worktree.workspaceId)).not.toBeInViewport();

    page.once("dialog", (dialog) => void dialog.accept());
    await pressArchiveShortcut(page);

    const toast = page.getByTestId("workspace-archived-toast");
    await expect(toast).toBeInViewport();
    const toastBox = await toast.boundingBox();
    if (!toastBox) throw new Error("Toast is not laid out");
    expect(toastBox.y).toBeLessThan(page.viewportSize()!.height / 2);
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
    await expectHostWorkspaceSettledActive(client, worktree.workspaceId);
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

  test("opening the workspace while its undo is still running keeps its tabs", async ({ page }) => {
    const teardown = createGatedTeardown();
    const repo = await createTempGitRepo("archive-undo-tabs-", {
      paseoConfig: teardown.paseoConfig,
    });
    const seedClient = await connectSeedClient();
    try {
      await openProjectViaDaemon(client, repo.path);
      const worktree = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: `archive-undo-tabs-${Date.now()}`,
      });
      worktreeDirectories.add(worktree.workspaceDirectory);
      const target = { cwd: worktree.workspaceDirectory, workspaceId: worktree.workspaceId };
      const agents = [
        await createMockIdleAgent(seedClient, { ...target, title: "first" }),
        await createMockIdleAgent(seedClient, { ...target, title: "second" }),
      ] as const;
      await openWorkspaceWithAgents(page, [agents[0], agents[1]]);
      const tabsBefore = await getWorkspaceTabTestIds(page);

      await archiveFromRowButton(page, worktree.workspaceId);
      // The archive has taken its agents down and now parks in teardown.
      await teardown.expectStarted();
      await undoButton(page).click();
      await workspaceRow(page, worktree.workspaceId).click();

      for (const agent of agents) {
        await expect(page.getByTestId(`workspace-tab-agent_${agent.id}`).first()).toBeVisible();
      }
      teardown.release();
      await expectHostWorkspaceSettledActive(client, worktree.workspaceId);
      await expect.poll(() => getWorkspaceTabTestIds(page)).toEqual(tabsBefore);
    } finally {
      teardown.release();
      await seedClient.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("Cmd/Ctrl+Z without an archive to undo leaves the sidebar alone", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-none");

    await pressUndoShortcut(page);

    await expect(undoButton(page)).toHaveCount(0);
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
  });
});
