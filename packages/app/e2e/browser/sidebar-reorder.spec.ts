import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { getServerId } from "../support/helpers/server-id";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  openSidebarDisplayPage,
  selectSidebarStatusGrouping,
  closeSidebarDisplayPreferences,
} from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

async function rowTestIds(rows: Locator) {
  return rows.evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-testid")),
  );
}

async function visibleBoundingBox(row: Locator) {
  const box = await row.boundingBox();
  if (!box) throw new Error("Expected a visible draggable row");
  return box;
}

async function pressProjectRow(rows: Locator) {
  await rows.page().mouse.down();
}

async function pressWorkspaceRow(rows: Locator) {
  const solidScrimStop = rows
    .nth(0)
    .getByTestId("sidebar-workspace-trailing-scrim")
    .locator("stop")
    .nth(1);
  const hoverScrimColor = await solidScrimStop.getAttribute("stop-color");
  await rows.page().mouse.down();
  await expect.poll(() => solidScrimStop.getAttribute("stop-color")).not.toBe(hoverScrimColor);
}

async function quickDragFirstRowAfterSecond(
  rows: Locator,
  pressRow: (rows: Locator) => Promise<void>,
) {
  await expect(rows).toHaveCount(2);
  const before = await rowTestIds(rows);
  const sourceBox = await visibleBoundingBox(rows.nth(0));
  const targetBox = await visibleBoundingBox(rows.nth(1));

  const page = rows.page();
  const source = { x: sourceBox.x + sourceBox.width / 2, y: sourceBox.y + sourceBox.height / 2 };
  const target = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

  await page.mouse.move(source.x, source.y);
  const trailingScrim = rows.nth(0).getByTestId("sidebar-workspace-trailing-scrim");
  await pressRow(rows);
  await page.mouse.move(source.x, source.y + 7);
  await expect(trailingScrim).toHaveCount(0);
  await page.mouse.move(target.x, target.y, { steps: 4 });
  await page.mouse.up();

  await expect.poll(() => rowTestIds(rows)).toEqual([before[1], before[0]]);
}

test("projects, workspaces, and pinned chats reorder with an immediate mouse drag", async ({
  page,
}) => {
  const firstProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-first-" });
  const secondProject = await seedWorkspace({ repoPrefix: "sidebar-reorder-second-" });

  try {
    const secondWorkspace = await firstProject.client.createWorkspace({
      source: {
        kind: "directory",
        path: firstProject.repoPath,
        projectId: firstProject.projectId,
      },
      title: "Second workspace",
    });
    if (!secondWorkspace.workspace) {
      throw new Error(secondWorkspace.error ?? "Failed to seed a second workspace");
    }

    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    const firstProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(firstProject.projectKey)}`;
    const secondProjectTestId = `sidebar-project-row-${projectEquivalenceViewKey(secondProject.projectKey)}`;
    await quickDragFirstRowAfterSecond(
      page.locator(`[data-testid="${firstProjectTestId}"], [data-testid="${secondProjectTestId}"]`),
      pressProjectRow,
    );
    const firstWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${firstProject.workspaceId}`;
    const secondWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondWorkspace.workspace.id}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );

    await firstProject.client.setWorkspacePinned(firstProject.workspaceId, true);
    await secondProject.client.setWorkspacePinned(secondProject.workspaceId, true);
    const secondProjectWorkspaceTestId = `sidebar-workspace-row-${getServerId()}:${secondProject.workspaceId}`;
    await quickDragFirstRowAfterSecond(
      page.locator(
        `[data-testid="${firstWorkspaceTestId}"], [data-testid="${secondProjectWorkspaceTestId}"]`,
      ),
      pressWorkspaceRow,
    );
  } finally {
    await firstProject.cleanup();
    await secondProject.cleanup();
  }
});

test("project sorting restores custom drag order and is hidden in status grouping", async ({
  page,
}, testInfo) => {
  const zeta = await seedWorkspace({ repoPrefix: "sidebar-sort-zeta-", title: "Zeta work" });
  const alpha = await seedWorkspace({ repoPrefix: "sidebar-sort-alpha-", title: "Alpha work" });
  const alphaId = `sidebar-project-row-${projectEquivalenceViewKey(alpha.projectKey)}`;
  const zetaId = `sidebar-project-row-${projectEquivalenceViewKey(zeta.projectKey)}`;
  try {
    await zeta.client.renameProject(zeta.projectId, "Zeta");
    await alpha.client.renameProject(alpha.projectId, "Alpha");
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    const rows = page.locator(`[data-testid="${alphaId}"], [data-testid="${zetaId}"]`);
    await expect(rows).toHaveCount(2);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await quickDragFirstRowAfterSecond(rows, pressProjectRow);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toContainText("Custom order");
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await openSidebarDisplayPage(page, "sidebar-display-sorting");
    await page.getByTestId("sidebar-sorting-custom").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await selectSidebarStatusGrouping(page);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-project").click();
    await page.reload();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-sorting")).toContainText("Custom order");
    await page.screenshot({ path: testInfo.outputPath("sidebar-display-preferences.png") });
  } finally {
    await alpha.cleanup();
    await zeta.cleanup();
  }
});

test("empty-project sorting is contextual and restores custom drag order in status grouping", async ({
  page,
}) => {
  const zeta = await seedWorkspace({ repoPrefix: "empty-sort-zeta-" });
  const alpha = await seedWorkspace({ repoPrefix: "empty-sort-alpha-" });
  const occupied = await seedWorkspace({ repoPrefix: "empty-sort-occupied-" });
  const alphaId = `sidebar-project-row-${projectEquivalenceViewKey(alpha.projectKey)}`;
  const zetaId = `sidebar-project-row-${projectEquivalenceViewKey(zeta.projectKey)}`;
  try {
    await zeta.client.renameProject(zeta.projectId, "Zeta");
    await alpha.client.renameProject(alpha.projectId, "Alpha");
    await zeta.client.archiveWorkspace(zeta.workspaceId);
    await alpha.client.archiveWorkspace(alpha.workspaceId);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await selectSidebarStatusGrouping(page);
    const rows = page.locator(`[data-testid="${alphaId}"], [data-testid="${zetaId}"]`);
    await expect(rows).toHaveCount(2);
    const statusRows = page
      .getByTestId("sidebar-status-group-rows-done")
      .locator('[data-testid^="sidebar-workspace-row-"]');
    const initialWorkspaceOrder = await rowTestIds(statusRows);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await expect(page.getByTestId("sidebar-empty-project-sorting-status")).toHaveCount(0);
    await page.getByTestId("sidebar-empty-project-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await quickDragFirstRowAfterSecond(rows, pressProjectRow);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toContainText(
      "Custom order",
    );
    await expect(page.getByTestId("sidebar-display-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await page.getByTestId("sidebar-empty-project-sorting-project").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await page.reload();
    await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
    await openSidebarDisplayPage(page, "sidebar-display-empty-project-sorting");
    await page.getByTestId("sidebar-empty-project-sorting-custom").click();
    await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
    await expect.poll(() => rowTestIds(statusRows)).toEqual(initialWorkspaceOrder);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-empty-projects").click();
    await closeSidebarDisplayPreferences(page);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-grouping");
    await page.getByTestId("sidebar-grouping-empty-projects").click();
    await closeSidebarDisplayPreferences(page);
    await openSidebarDisplayPage(page, "sidebar-display-project-visibility");
    await page.getByTestId("sidebar-project-visibility-unarchived").click();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-empty-project-sorting")).toHaveCount(0);
    await closeSidebarDisplayPreferences(page);
  } finally {
    await occupied.cleanup();
    await alpha.cleanup();
    await zeta.cleanup();
  }
});

/** Seed two workspace rows whose names expose alphabetical and saved drag order. */
async function seedSortableWorkspaceRows(page: Page) {
  const first = await seedWorkspace({ repoPrefix: "sidebar-workspace-sort-", title: "Zeta" });
  try {
    const created = await first.client.createWorkspace({
      source: { kind: "directory", path: first.repoPath, projectId: first.projectId },
      title: "Alpha",
    });
    if (!created.workspace) throw new Error(created.error ?? "Failed to create workspace");
    const zetaId = `sidebar-workspace-row-${getServerId()}:${first.workspaceId}`;
    const alphaId = `sidebar-workspace-row-${getServerId()}:${created.workspace.id}`;
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    return {
      rows: page.locator(`[data-testid="${alphaId}"], [data-testid="${zetaId}"]`),
      alphaId,
      zetaId,
      cleanup: first.cleanup,
    };
  } catch (error) {
    await first.cleanup();
    throw error;
  }
}

/** Verify that alphabetical sorting leaves drag order available and saved across reloads. */
async function expectWorkspaceSortingRestoresCustomOrder(
  page: Page,
  { rows, alphaId, zetaId }: Awaited<ReturnType<typeof seedSortableWorkspaceRows>>,
) {
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-name").click();
  await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
  await quickDragFirstRowAfterSecond(rows, pressWorkspaceRow);
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await expect(page.getByTestId("sidebar-display-workspace-sorting")).toContainText("Custom order");
  await closeSidebarDisplayPreferences(page);
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-name").click();
  await expect.poll(() => rowTestIds(rows)).toEqual([alphaId, zetaId]);
  await openSidebarDisplayPage(page, "sidebar-display-workspace-sorting");
  await page.getByTestId("sidebar-workspace-sorting-custom").click();
  await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
  await page.reload();
  await expect.poll(() => rowTestIds(rows)).toEqual([zetaId, alphaId]);
}

test("workspace sorting restores custom drag order in project grouping", async ({ page }) => {
  const seeded = await seedSortableWorkspaceRows(page);
  try {
    await expectWorkspaceSortingRestoresCustomOrder(page, seeded);
  } finally {
    await seeded.cleanup();
  }
});

test("workspace sorting restores custom drag order in status grouping", async ({ page }) => {
  const seeded = await seedSortableWorkspaceRows(page);
  try {
    await selectSidebarStatusGrouping(page);
    await expectWorkspaceSortingRestoresCustomOrder(page, seeded);
  } finally {
    await seeded.cleanup();
  }
});
