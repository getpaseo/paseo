import { test, expect } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

function sidebarProjectRowTestId(projectId: string) {
  return `sidebar-project-row-${getServerId()}:${projectId}`;
}

function sidebarWorkspaceRowTestId(workspaceId: string) {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function waitForSidebarWorkspace(page: import("@playwright/test").Page, workspaceId: string) {
  const row = page.getByTestId(sidebarWorkspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function waitForSidebarProject(page: import("@playwright/test").Page, projectId: string) {
  const row = page.getByTestId(sidebarProjectRowTestId(projectId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  return row;
}

async function openSortMenu(page: import("@playwright/test").Page) {
  const prefsTrigger = page.getByTestId("sidebar-display-preferences-menu").first();
  await expect(prefsTrigger).toBeVisible();
  await prefsTrigger.click();
}

async function dragReorder(
  page: import("@playwright/test").Page,
  source: import("@playwright/test").Locator,
  target: import("@playwright/test").Locator,
) {
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("missing drag boxes");

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  // dnd-kit PointerSensor uses a hold-based activation when useDragHandle is
  // enabled; wait until the source element shows the active dragging transform
  // before moving, instead of a blind fixed sleep.
  await expect(async () => {
    const transform = await source.evaluate((el) => window.getComputedStyle(el).transform);
    expect(transform).toContain("scale(1.02)");
  }).toPass({ timeout: 1000 });
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height + 8);
  await page.mouse.up();
}

test.describe("Sidebar drag reorder", () => {
  test("reordering projects persists", async ({ page }) => {
    const workspaceA = await seedWorkspace({ repoPrefix: "drag-a-" });
    const workspaceB = await seedWorkspace({ repoPrefix: "drag-b-" });

    try {
      await gotoAppShell(page);
      const projectA = await waitForSidebarProject(page, workspaceA.projectId);
      const projectB = await waitForSidebarProject(page, workspaceB.projectId);

      await openSortMenu(page);
      await page.getByTestId("sidebar-sort-custom").click();

      await expect(projectA).toBeVisible();
      await expect(projectB).toBeVisible();

      await dragReorder(page, projectA, projectB);

      const projectRows = page.getByTestId(/^sidebar-project-row-/);
      await expect(projectRows.first()).toHaveAttribute(
        "data-testid",
        sidebarProjectRowTestId(workspaceB.projectId),
        { timeout: 10_000 },
      );
      await expect(projectRows.nth(1)).toHaveAttribute(
        "data-testid",
        sidebarProjectRowTestId(workspaceA.projectId),
        { timeout: 10_000 },
      );

      await page.reload();
      await waitForSidebarProject(page, workspaceA.projectId);
      const reloadedRows = page.getByTestId(/^sidebar-project-row-/);
      await expect(reloadedRows.first()).toHaveAttribute(
        "data-testid",
        sidebarProjectRowTestId(workspaceB.projectId),
        { timeout: 30_000 },
      );
    } finally {
      await workspaceA.cleanup();
      await workspaceB.cleanup();
    }
  });

  test("reordering workspaces inside a project persists", async ({ page }) => {
    const sharedOrigin = `https://github.com/paseo-e2e/drag-ws-${Date.now()}.git`;
    const workspaceA = await seedWorkspace({
      repoPrefix: "drag-ws-a-",
      repo: { originUrl: sharedOrigin },
    });
    const workspaceB = await seedWorkspace({
      repoPrefix: "drag-ws-b-",
      repo: { originUrl: sharedOrigin },
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarProject(page, workspaceA.projectId);

      await openSortMenu(page);
      await page.getByTestId("sidebar-sort-custom").click();

      const firstWs = await waitForSidebarWorkspace(page, workspaceA.workspaceId);
      const secondWs = await waitForSidebarWorkspace(page, workspaceB.workspaceId);

      await dragReorder(page, firstWs, secondWs);

      await expect(page.getByTestId(sidebarWorkspaceRowTestId(workspaceB.workspaceId))).toBeVisible(
        { timeout: 10_000 },
      );

      await page.reload();
      await waitForSidebarProject(page, workspaceA.projectId);
      await waitForSidebarWorkspace(page, workspaceB.workspaceId);
    } finally {
      await workspaceA.cleanup();
      await workspaceB.cleanup();
    }
  });
});
