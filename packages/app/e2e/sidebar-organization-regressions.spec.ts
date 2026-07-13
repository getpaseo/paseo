import { expect, test, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { gotoWorkspace } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(workspaceRowTestId(workspaceId));
}

function projectRow(page: Page, projectId: string) {
  return page.getByTestId(`sidebar-project-row-${projectId}`);
}

async function selectSidebarGroup(page: Page, group: "none" | "project"): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await page.getByTestId("sidebar-organization-page-group").click();
  await page.getByTestId(`sidebar-grouping-${group}`).click();
  await page.keyboard.press("Escape");
}

async function selectSidebarVisibility(page: Page, visibility: "all"): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await page.getByTestId("sidebar-organization-page-visibility").click();
  await page.getByTestId(`sidebar-visibility-filter-${visibility}`).click();
  await page.keyboard.press("Escape");
}

async function selectProjectMenuAction(
  page: Page,
  projectId: string,
  action: "hide" | "pin",
): Promise<void> {
  const row = projectRow(page, projectId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();
  await page.getByTestId(`sidebar-project-kebab-${projectId}`).click();
  await page.getByTestId(`sidebar-project-menu-${action}-${projectId}`).click();
}

async function rowY(page: Page, projectId: string): Promise<number> {
  const box = await projectRow(page, projectId).boundingBox();
  if (!box) throw new Error(`Project row ${projectId} has no bounding box`);
  return box.y;
}

async function dragProjectBefore(page: Page, sourceProjectId: string, targetProjectId: string) {
  const source = await projectRow(page, sourceProjectId).boundingBox();
  const target = await projectRow(page, targetProjectId).boundingBox();
  if (!source || !target) throw new Error("Project row disappeared before drag");

  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 8, {
    steps: 4,
  });
  await page.mouse.move(target.x + target.width / 2, target.y + 2, { steps: 12 });
  await page.mouse.up();
}

test.describe("Sidebar organization regressions", () => {
  test("the workspace pin shortcut works when grouping is None", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-pin-none-" });

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForSidebarHydration(page);
      await selectSidebarGroup(page, "none");
      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });
      const unpinnedBox = await workspaceRow(page, workspace.workspaceId).boundingBox();
      if (!unpinnedBox) throw new Error("Unpinned workspace row has no bounding box");

      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+Shift+P`);

      const pinnedSection = page.getByTestId("sidebar-pinned-section");
      await expect(pinnedSection).toBeVisible({ timeout: 30_000 });
      const pinnedRow = pinnedSection.getByTestId(workspaceRowTestId(workspace.workspaceId));
      await expect(pinnedRow).toBeVisible();
      const pinnedBox = await pinnedRow.boundingBox();
      if (!pinnedBox) throw new Error("Pinned workspace row has no bounding box");
      expect(Math.abs(pinnedBox.height - unpinnedBox.height)).toBeLessThanOrEqual(1);

      await page.keyboard.press(`${modifier}+Shift+P`);
      await expect(pinnedSection).toHaveCount(0, { timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps hidden-project recovery visible when grouping is None", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-hidden-none-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectProjectMenuAction(page, workspace.projectId, "hide");

      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
      await selectSidebarGroup(page, "none");
      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
      await selectSidebarVisibility(page, "all");

      await expect(page.getByTestId("sidebar-hidden-projects-section")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId(`sidebar-hidden-project-${workspace.projectId}`)).toBeVisible();
    } finally {
      await workspace.cleanup();
    }
  });

  test("project headers in None grouping do not change collapse state", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-none-collapse-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });

      await selectSidebarGroup(page, "none");
      await projectRow(page, workspace.projectId).click();
      await selectSidebarGroup(page, "project");

      await expect(workspaceRow(page, workspace.workspaceId)).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });

  test("pinning a project keeps unpinned projects reorderable within their partition", async ({
    page,
  }) => {
    const workspaces: SeededWorkspace[] = [];
    try {
      for (const repoPrefix of ["sidebar-pinned-", "sidebar-order-a-", "sidebar-order-b-"]) {
        workspaces.push(await seedWorkspace({ repoPrefix }));
      }
      const [pinned, firstUnpinned, secondUnpinned] = workspaces;
      if (!pinned || !firstUnpinned || !secondUnpinned) {
        throw new Error("Expected three seeded projects");
      }

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await selectProjectMenuAction(page, pinned.projectId, "pin");

      await expect(page.getByText("Pinned projects", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("sidebar-unpinned-project-list")).toBeVisible();

      const firstY = await rowY(page, firstUnpinned.projectId);
      const secondY = await rowY(page, secondUnpinned.projectId);
      const source = firstY > secondY ? firstUnpinned : secondUnpinned;
      const target = firstY > secondY ? secondUnpinned : firstUnpinned;

      await dragProjectBefore(page, source.projectId, target.projectId);
      await expect
        .poll(
          async () => (await rowY(page, source.projectId)) < (await rowY(page, target.projectId)),
        )
        .toBe(true);
      await expect
        .poll(
          async () => (await rowY(page, pinned.projectId)) < (await rowY(page, source.projectId)),
        )
        .toBe(true);
    } finally {
      await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
    }
  });
});
