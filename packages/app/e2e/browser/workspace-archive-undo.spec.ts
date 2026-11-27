import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveLocalWorkspaceFromDaemon,
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import { expectWorkspaceAbsentFromSidebar } from "../support/helpers/sidebar";
import {
  createMockIdleAgent,
  fetchAgentArchivedAt,
  openSessions,
  openWorkspaceWithAgents,
} from "../support/helpers/archive-tab";
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
  readSidebarListLayout,
  recordLastRowBottomPerFrame,
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

async function clearIndexedDbDatabases(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    for (const db of dbs) {
      if (!db.name) continue;
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(db.name!);
        const done = () => resolve();
        req.addEventListener("success", done, { once: true });
        req.addEventListener("error", done, { once: true });
        req.addEventListener("blocked", done, { once: true });
      });
    }
  });
}

async function delayRefreshAgentRequests(page: Page, delayMs: number): Promise<void> {
  await page.routeWebSocket(/\/ws/, (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((message) => {
      if (typeof message === "string" && isRefreshAgentRequestMessage(message)) {
        setTimeout(() => {
          server.send(message);
        }, delayMs);
        return;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      ws.send(message);
    });
  });
}

function isRefreshAgentRequestMessage(message: string): boolean {
  try {
    const parsed = JSON.parse(message) as { type?: string; message?: { type?: string } };
    return (
      parsed.type === "refresh_agent_request" || parsed.message?.type === "refresh_agent_request"
    );
  } catch {
    return false;
  }
}

async function isSidebarFooterHitTestable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const footer = document.querySelector('[data-testid="sidebar-footer"]');
    if (!(footer instanceof HTMLElement)) return false;
    const rect = footer.getBoundingClientRect();
    const topEl = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return Boolean(topEl && footer.contains(topEl));
  });
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

  test("a long list scrolls its last row clear of the toast, and settles back smoothly after it", async ({
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
      const restingEndGap = resting.listBottom - resting.rowBottoms.at(-1)!;
      expect(restingEndGap).toBeLessThan(resting.rowHeight);

      await archiveFromRowButton(page, worktree.workspaceId);
      await page.mouse.move(0, 0);
      const toastBox = await archivedToast(page).boundingBox();
      if (!toastBox) throw new Error("Toast is not laid out");
      // The list keeps its usual end gap, measured from the toast's top instead of its own bottom.
      await expect
        .poll(async () => {
          const layout = await scrollSidebarListToEnd(page);
          return Math.round(toastBox.y - layout.rowBottoms.at(-1)!);
        })
        .toBe(Math.round(restingEndGap));

      const frames = recordLastRowBottomPerFrame(page, 40);
      await outlastUndoWindow(page);
      const bottoms = await frames;
      await expect(archivedToast(page)).toHaveCount(0);

      // Without scrolling again, the list ends just below its last row once more.
      const settled = await readSidebarListLayout(page);
      expect(settled.listBottom - settled.rowBottoms.at(-1)!).toBeCloseTo(restingEndGap, 0);
      // The rows travel down by the toast's height over several frames, never in one jump.
      const travel = bottoms.at(-1)! - bottoms[0]!;
      expect(travel).toBeGreaterThan(toastBox.height);
      const steps = bottoms.slice(1).map((bottom, index) => bottom - bottoms[index]!);
      expect(Math.min(...steps)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...steps)).toBeLessThan(travel / 2);
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
      const preArchivedAgent = await createMockIdleAgent(seedClient, {
        ...target,
        title: "pre-archived",
      });
      await seedClient.archiveAgent(preArchivedAgent.id);
      await expect.poll(() => fetchAgentArchivedAt(seedClient, preArchivedAgent.id)).not.toBeNull();
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
      await expect(
        page.getByTestId("agent-unarchiving-callout").filter({ visible: true }),
      ).toHaveCount(1);
      await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toHaveCount(0);

      // Opening an agent that was already archived before the workspace archive still shows
      // the manual Unarchive callout rather than claiming it is unarchiving with the workspace.
      await openSessions(page);
      await page.getByTestId(`agent-row-${getServerId()}-${preArchivedAgent.id}`).click();
      await expect(page.getByTestId("agent-archived-callout")).toBeVisible();
      await expect(page.getByRole("button", { name: "Unarchive", exact: true })).toBeVisible();
      await expect(
        page.getByTestId("agent-unarchiving-callout").filter({ visible: true }),
      ).toHaveCount(0);

      await page.getByTestId(`workspace-tab-agent_${agents[0].id}`).first().click();
      await expect(
        page.getByTestId("agent-unarchiving-callout").filter({ visible: true }),
      ).toHaveCount(1);

      await page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        let sawAgentLoading = false;
        let running = true;
        const isVisible = (el: Element | null) => {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const tick = () => {
          if (!running) return;
          if (
            Array.from(document.querySelectorAll('[data-testid="agent-loading"]')).some(isVisible)
          ) {
            sawAgentLoading = true;
          }
          requestAnimationFrame(tick);
        };
        win.__stopMidUndoLoadingCheck = () => {
          running = false;
          return sawAgentLoading;
        };
        requestAnimationFrame(tick);
      });

      teardown.release();
      await expectHostWorkspaceSettledActive(client, worktree.workspaceId);
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable({
        timeout: 30_000,
      });
      const sawMidUndoLoading = await page.evaluate(() => {
        const win = window as unknown as { __stopMidUndoLoadingCheck?: () => boolean };
        return win.__stopMidUndoLoadingCheck?.();
      });
      expect(sawMidUndoLoading).toBe(false);
      await expect
        .poll(() => getWorkspaceTabTestIds(page))
        .toEqual([...tabsBefore, `workspace-tab-agent_${preArchivedAgent.id}`]);
    } finally {
      teardown.release();
      await seedClient.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("archives a restored workspace while its undo is queued", async ({ page }) => {
    const teardown = createGatedTeardown();
    const repo = await createTempGitRepo("archive-undo-archive-", {
      paseoConfig: teardown.paseoConfig,
    });

    try {
      await openProjectViaDaemon(client, repo.path);
      const worktree = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: "archive-undo-archive",
      });
      worktreeDirectories.add(worktree.workspaceDirectory);
      await gotoAppShell(page);
      await archiveFromRowButton(page, worktree.workspaceId);
      await teardown.expectStarted();

      await undoButton(page).click();
      await workspaceRow(page, worktree.workspaceId).click();
      await expect(page).toHaveURL(new RegExp(`/workspace/${worktree.workspaceId}$`));

      await pressArchiveShortcut(page);
      await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
      teardown.release();
      await expectDirectoryPresence(worktree.workspaceDirectory, false);
    } finally {
      teardown.release();
      await repo.cleanup();
    }
  });

  test("Cmd/Ctrl+Z without an archive to undo leaves the sidebar alone", async ({ page }) => {
    const worktree = await seedWorktree(page, "archive-undo-none");

    await pressUndoShortcut(page);

    await expect(undoButton(page)).toHaveCount(0);
    await expect(workspaceRow(page, worktree.workspaceId)).toBeVisible();
  });

  test("unarchiving a workspace with archived agents skips archived-callout and loading flashes", async ({
    page,
  }) => {
    const seedClient = await connectSeedClient();
    const project = await openProjectViaDaemon(client, tempRepo.path);
    try {
      const agent1 = await createMockIdleAgent(seedClient, {
        cwd: project.workspaceDirectory,
        workspaceId: project.workspaceId,
        title: "Atomic restore agent 1",
      });
      const agent2 = await createMockIdleAgent(seedClient, {
        cwd: project.workspaceDirectory,
        workspaceId: project.workspaceId,
        title: "Atomic restore agent 2",
      });
      // Seed 25 turns so the archived conversation spans multiple timeline pages (hasOlder=true).
      for (let i = 0; i < 25; i += 1) {
        await seedClient.sendAgentMessage(
          agent1.id,
          `atomic-restore-turn-${i}: emit 1 coalesced agent stream updates`,
        );
        await seedClient.waitForFinish(agent1.id, 15_000);
      }

      await archiveLocalWorkspaceFromDaemon(client, project.workspaceId);
      await expect.poll(() => fetchAgentArchivedAt(seedClient, agent1.id)).not.toBeNull();
      await expect.poll(() => fetchAgentArchivedAt(seedClient, agent2.id)).not.toBeNull();

      await gotoAppShell(page);
      // Clear persisted replica IndexedDB so this tests a true cold restore.
      await clearIndexedDbDatabases(page);
      await page.reload();
      await waitForSidebarHydration(page);
      await openSessions(page);
      await page.getByTestId(`agent-row-${getServerId()}-${agent1.id}`).click();
      await expect(page.getByTestId("workspace-recovery-action")).toHaveText("Unarchive", {
        timeout: 30_000,
      });

      // Verify the compact left sidebar overlays the recovery gate rather than painting behind it.
      const desktopViewport = page.viewportSize() ?? { width: 1280, height: 720 };
      await page.setViewportSize({ width: 390, height: 720 });
      await page.getByRole("button", { name: "Open menu", exact: true }).first().click();
      const sidebarFooter = page.getByTestId("sidebar-footer").first();
      await expect(sidebarFooter).toBeVisible();
      await expect.poll(() => isSidebarFooterHitTestable(page)).toBe(true);
      await page.setViewportSize(desktopViewport);
      await expect(page.getByTestId("workspace-recovery-action")).toBeVisible();

      await page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        const recoveryButton = document.querySelector('[data-testid="workspace-recovery-action"]');
        const seen = {
          archivedCallout: false,
          agentLoading: false,
          agentInitialFill: false,
          updatingToast: false,
          recoveryButtonRemounted: false,
          firstRevealedTabsCount: -1,
          firstRevealedRowCount: -1,
          firstRevealedStreamOpacity: -1,
          firstRevealedDistanceFromBottom: -1,
        };
        let running = true;
        const isVisible = (el: Element | null) => {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const tick = () => {
          if (!running) return;
          const currentRecoveryButton = document.querySelector(
            '[data-testid="workspace-recovery-action"]',
          );
          if (currentRecoveryButton && recoveryButton && currentRecoveryButton !== recoveryButton) {
            seen.recoveryButtonRemounted = true;
          }
          if (
            Array.from(document.querySelectorAll('[data-testid="agent-archived-callout"]')).some(
              isVisible,
            )
          ) {
            seen.archivedCallout = true;
          }
          if (
            Array.from(document.querySelectorAll('[data-testid="agent-loading"]')).some(isVisible)
          ) {
            seen.agentLoading = true;
          }
          if (
            Array.from(document.querySelectorAll('[data-testid="agent-initial-fill"]')).some(
              isVisible,
            )
          ) {
            seen.agentInitialFill = true;
          }
          if (
            Array.from(document.querySelectorAll('[data-testid="agent-updating-toast"]')).some(
              isVisible,
            )
          ) {
            seen.updatingToast = true;
          }
          const composerVisible = Array.from(
            document.querySelectorAll(
              'textarea[aria-label="Message agent..."], [role="textbox"][aria-label="Message agent..."]',
            ),
          ).some(isVisible);
          if (seen.firstRevealedTabsCount === -1 && composerVisible) {
            seen.firstRevealedTabsCount = Array.from(
              document.querySelectorAll('[data-testid^="workspace-tab-"]'),
            ).filter(isVisible).length;
            const stream =
              Array.from(document.querySelectorAll('[data-testid="agent-chat-scroll"]')).find(
                isVisible,
              ) ?? null;
            if (stream instanceof HTMLElement) {
              seen.firstRevealedRowCount = stream.querySelectorAll("[data-history-row-id]").length;
              seen.firstRevealedStreamOpacity = Number.parseFloat(
                getComputedStyle(stream).opacity || "1",
              );
              seen.firstRevealedDistanceFromBottom = Math.max(
                0,
                Math.round(stream.scrollHeight - stream.scrollTop - stream.clientHeight),
              );
            }
          }
          requestAnimationFrame(tick);
        };
        win.__stopUnarchiveFlashCheck = () => {
          running = false;
          return seen;
        };
        requestAnimationFrame(tick);
      });

      await page.getByTestId("workspace-recovery-action").click();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable({
        timeout: 30_000,
      });
      await expect(
        page.getByText("atomic-restore-turn-24", { exact: false }).first(),
      ).toBeVisible();
      const seen = await page.evaluate(() => {
        const win = window as unknown as {
          __stopUnarchiveFlashCheck?: () => {
            archivedCallout: boolean;
            agentLoading: boolean;
            agentInitialFill: boolean;
            updatingToast: boolean;
            recoveryButtonRemounted: boolean;
            firstRevealedTabsCount: number;
            firstRevealedRowCount: number;
            firstRevealedStreamOpacity: number;
            firstRevealedDistanceFromBottom: number;
          };
        };
        return win.__stopUnarchiveFlashCheck?.();
      });
      expect(seen).toBeDefined();
      expect({
        archivedCallout: seen?.archivedCallout,
        agentLoading: seen?.agentLoading,
        agentInitialFill: seen?.agentInitialFill,
        updatingToast: seen?.updatingToast,
        recoveryButtonRemounted: seen?.recoveryButtonRemounted,
        firstRevealedTabsCount: seen?.firstRevealedTabsCount,
        firstRevealedStreamOpacity: seen?.firstRevealedStreamOpacity,
      }).toEqual({
        archivedCallout: false,
        agentLoading: false,
        agentInitialFill: false,
        updatingToast: false,
        recoveryButtonRemounted: false,
        firstRevealedTabsCount: 2,
        firstRevealedStreamOpacity: 1,
      });
      expect(seen!.firstRevealedRowCount).toBeGreaterThan(0);
      expect(seen!.firstRevealedDistanceFromBottom).toBeLessThanOrEqual(16);
    } finally {
      await client.removeProject(project.projectKey).catch(() => undefined);
      await seedClient.close().catch(() => undefined);
    }
  });

  test("unarchiving a single archived agent keeps the chat mounted without a loading flash", async ({
    page,
  }) => {
    const seedClient = await connectSeedClient();
    const project = await openProjectViaDaemon(client, tempRepo.path);
    try {
      const agent1 = await createMockIdleAgent(seedClient, {
        cwd: project.workspaceDirectory,
        workspaceId: project.workspaceId,
        title: "Single unarchive agent",
      });
      await createMockIdleAgent(seedClient, {
        cwd: project.workspaceDirectory,
        workspaceId: project.workspaceId,
        title: "Sibling active agent",
      });
      for (let i = 0; i < 6; i += 1) {
        await seedClient.sendAgentMessage(
          agent1.id,
          `single-unarchive-turn-${i}: emit 1 coalesced agent stream updates`,
        );
        await seedClient.waitForFinish(agent1.id, 15_000);
      }
      await seedClient.archiveAgent(agent1.id);
      await expect.poll(() => fetchAgentArchivedAt(seedClient, agent1.id)).not.toBeNull();

      // Delay `refresh_agent_request` briefly so the UI renders its busy state on the Unarchive button.
      await delayRefreshAgentRequests(page, 250);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openSessions(page);
      await page.getByTestId(`agent-row-${getServerId()}-${agent1.id}`).click();
      const unarchiveBtn = page.getByRole("button", { name: "Unarchive", exact: true });
      await expect(unarchiveBtn).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByText("single-unarchive-turn-5", { exact: false }).first(),
      ).toBeVisible();

      const idleCalloutBox = await page.getByTestId("agent-archived-callout").boundingBox();
      if (!idleCalloutBox) throw new Error("Archived callout is not laid out");

      await page.evaluate(() => {
        const win = window as unknown as Record<string, unknown>;
        const state = {
          sawAgentLoading: false,
          sawUnarchivingCallout: false,
          unarchivingCalloutHeights: [] as number[],
          minRowCount: Number.POSITIVE_INFINITY,
          minStreamOpacity: Number.POSITIVE_INFINITY,
        };
        let running = true;
        const isVisible = (el: Element | null) => {
          if (!el || !(el instanceof HTMLElement)) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const style = getComputedStyle(el);
          return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
        };
        const tick = () => {
          if (!running) return;
          if (
            Array.from(document.querySelectorAll('[data-testid="agent-loading"]')).some(isVisible)
          ) {
            state.sawAgentLoading = true;
          }
          const stream =
            Array.from(document.querySelectorAll('[data-testid="agent-chat-scroll"]')).find(
              isVisible,
            ) ?? null;
          if (stream instanceof HTMLElement) {
            const rowCount = stream.querySelectorAll("[data-history-row-id]").length;
            const opacity = Number.parseFloat(getComputedStyle(stream).opacity || "1");
            state.minRowCount = Math.min(state.minRowCount, rowCount);
            state.minStreamOpacity = Math.min(state.minStreamOpacity, opacity);
          } else {
            state.minRowCount = 0;
            state.minStreamOpacity = 0;
          }
          const unarchivingCallout = Array.from(
            document.querySelectorAll('[data-testid="agent-unarchiving-callout"]'),
          ).find(isVisible);
          if (unarchivingCallout instanceof HTMLElement) {
            state.sawUnarchivingCallout = true;
            state.unarchivingCalloutHeights.push(
              Math.round(unarchivingCallout.getBoundingClientRect().height),
            );
          }
          requestAnimationFrame(tick);
        };
        win.__stopSingleUnarchiveCheck = () => {
          running = false;
          return state;
        };
        requestAnimationFrame(tick);
      });

      await unarchiveBtn.click();
      await expect(page.getByRole("textbox", { name: "Message agent..." })).toBeEditable({
        timeout: 30_000,
      });
      const result = await page.evaluate(() => {
        const win = window as unknown as {
          __stopSingleUnarchiveCheck?: () => {
            sawAgentLoading: boolean;
            sawUnarchivingCallout: boolean;
            unarchivingCalloutHeights: number[];
            minRowCount: number;
            minStreamOpacity: number;
          };
        };
        return win.__stopSingleUnarchiveCheck?.();
      });
      expect(result?.sawAgentLoading).toBe(false);
      expect(result?.sawUnarchivingCallout).toBe(true);
      expect(result?.minRowCount).toBeGreaterThan(0);
      expect(result?.minStreamOpacity).toBe(1);
      for (const height of result?.unarchivingCalloutHeights ?? []) {
        expect(Math.abs(height - Math.round(idleCalloutBox.height))).toBeLessThanOrEqual(1);
      }
    } finally {
      await client.removeProject(project.projectKey).catch(() => undefined);
      await seedClient.close().catch(() => undefined);
    }
  });
});
