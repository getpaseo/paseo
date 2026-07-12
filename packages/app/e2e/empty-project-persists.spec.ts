import path from "node:path";
import { existsSync } from "node:fs";
import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { expectOpenedProject } from "./helpers/project-picker-ui";
import { connectSeedClient, seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

function workspaceRowTestId(workspaceId: string): string {
  return `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
}

async function archiveWorkspaceFromSidebar(page: Page, workspaceId: string): Promise<void> {
  const serverId = getServerId();
  const row = page.getByTestId(workspaceRowTestId(workspaceId));
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${serverId}:${workspaceId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const archiveItem = page.getByTestId(`sidebar-workspace-menu-archive-${serverId}:${workspaceId}`);
  await expect(archiveItem).toBeVisible({ timeout: 10_000 });
  await archiveItem.click();
}

async function removeProjectFromSidebar(page: Page, projectId: string): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${projectId}`);
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const kebab = page.getByTestId(`sidebar-project-kebab-${projectId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  // Removing a project raises a browser confirm; accept it so the
  // user-confirmed removal proceeds deterministically.
  page.once("dialog", (dialog) => void dialog.accept());

  const removeItem = page.getByTestId(`sidebar-project-menu-remove-${projectId}`);
  await expect(removeItem).toBeVisible({ timeout: 10_000 });
  await removeItem.click();
}

async function addProjectFromPicker(page: Page, projectPath: string): Promise<string> {
  await page.getByTestId("sidebar-add-project").click();

  const input = page.getByTestId("project-picker-input");
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.fill(projectPath);
  await page.keyboard.press("Enter");

  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: path.basename(projectPath) })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  const testId = await projectRow.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  return testId!.replace("sidebar-project-row-", "");
}

async function waitForSidebarProjectListReady(page: Page): Promise<void> {
  await page
    .locator('[data-testid="sidebar-project-empty-state"], [data-testid^="sidebar-project-row-"]')
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
}

test.describe("Project picker search", () => {
  test("opens a project from a fuzzy directory-name search", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarProjectListReady(page);
    await page.getByTestId("sidebar-add-project").click();

    const input = page.getByTestId("project-picker-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill(projectPickerFixture.fuzzyQuery);

    const suggestion = page.getByText(projectPickerFixture.projectName, { exact: false }).first();
    await expect(suggestion).toBeVisible({ timeout: 30_000 });
    await suggestion.click();

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
  });

  test("shows a loading state after typing while directory suggestions are pending", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await waitForSidebarProjectListReady(page);
    await page.getByTestId("sidebar-add-project").click();

    const input = page.getByTestId("project-picker-input");
    await expect(input).toBeVisible({ timeout: 30_000 });
    await input.fill("paseo-loading-state-no-match");

    await expect(page.getByText("Start typing a path", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Searching...", { exact: true })).toBeVisible();
  });
});

// Projects are parents in the sidebar. Archiving the last workspace leaves the
// project row in place with a ghost "+ New workspace" child row.
test.describe("Project with no workspaces persists", () => {
  test("adding a project starts with only a new-workspace child row", async ({ page }) => {
    const repo = await createTempGitRepo("empty-project-add-");
    const client = await connectSeedClient();
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);
      await waitForSidebarProjectListReady(page);

      projectId = await addProjectFromPicker(page, repo.path);
      const projectRow = page.getByTestId(`sidebar-project-row-${projectId}`);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(projectRow).toContainText(path.basename(repo.path));
      await expect(page.getByTestId(`sidebar-workspace-list-${projectId}`)).toHaveCount(0);

      const newWorkspaceRow = page.getByTestId(`sidebar-project-new-workspace-row-${projectId}`);
      await expect(newWorkspaceRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toContainText("New workspace");

      const workspaces = await client.fetchWorkspaces({ filter: { projectId } });
      expect(workspaces.entries).toEqual([]);
    } finally {
      if (projectId) {
        await client.removeProject(projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("archiving the only workspace keeps the project row with creation still reachable", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "empty-project-persists-" });

    try {
      const projectRow = page.getByTestId(`sidebar-project-row-${workspace.projectId}`);
      const newWorkspaceRow = page.getByTestId(
        `sidebar-project-new-workspace-row-${workspace.projectId}`,
      );
      const globalNewWorkspace = page.getByTestId("sidebar-global-new-workspace");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      const workspaceRow = page.getByTestId(workspaceRowTestId(workspace.workspaceId));
      await expect(workspaceRow).toBeVisible({
        timeout: 30_000,
      });
      await workspaceRow.click();
      await expect(page.getByTestId("changes-primary-cta")).toHaveCount(0);

      await archiveWorkspaceFromSidebar(page, workspace.workspaceId);

      // The workspace row goes away, but its project parent stays and exposes a
      // child row for creating the next workspace.
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toHaveCount(0, {
        timeout: 30_000,
      });
      expect(existsSync(workspace.repoPath)).toBe(true);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toContainText("New workspace");
      await expect(globalNewWorkspace).toBeVisible({ timeout: 30_000 });

      // The project survives a reload after its last workspace is archived.
      await page.reload();
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(newWorkspaceRow).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});

test.describe("Project remove", () => {
  test("removing a project from project actions removes it from the sidebar", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "project-remove-sidebar-" });

    try {
      const projectRow = page.getByTestId(`sidebar-project-row-${workspace.projectId}`);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toBeVisible({
        timeout: 30_000,
      });

      await removeProjectFromSidebar(page, workspace.projectId);

      await expect(page.getByTestId(workspaceRowTestId(workspace.workspaceId))).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(projectRow).toHaveCount(0, { timeout: 30_000 });

      await page.reload();
      await waitForSidebarProjectListReady(page);
      await expect(projectRow).toHaveCount(0, { timeout: 30_000 });

      const readded = await workspace.client.addProject(workspace.repoPath);
      expect(readded.error).toBeNull();
      expect(readded.project?.projectDisplayName).toBe(workspace.projectDisplayName);

      await page.reload();
      await waitForSidebarHydration(page);
      await expect(projectRow).toBeVisible({ timeout: 30_000 });
      await expect(projectRow).toContainText(workspace.projectDisplayName);
      await expect(projectRow).not.toContainText(workspace.repoPath);
      await expect(
        page.getByTestId(`sidebar-project-new-workspace-row-${workspace.projectId}`),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await workspace.cleanup();
    }
  });
});
