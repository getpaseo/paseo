import { expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  expectAddProjectPage,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import { getServerId } from "../support/helpers/server-id";
import {
  closeSidebarDisplayPreferences,
  openSidebarProjectFilter,
  openProjectContextMenu,
  openMobileAgentSidebar,
  pinWorkspaceFromSidebar,
  selectAllProjectsFilter,
  selectSidebarStatusGrouping,
  toggleProjectFilter,
} from "../support/helpers/sidebar";

async function openProjectPopover(page: Page): Promise<void> {
  await page.getByTestId("sidebar-display-preferences-menu").click();
  await page.getByTestId("sidebar-display-project-filter").hover();
  await expect(page.getByTestId("sidebar-project-filter-all")).toBeInViewport();
}

test.describe("Sidebar project visibility", () => {
  test.describe.configure({ timeout: 180_000 });
  test.beforeEach(async ({ page }) => {
    page.setDefaultTimeout(15_000);
  });

  for (const method of ["directory-search", "new-directory"] as const) {
    test(`includes a project added through ${method} without revealing excluded projects`, async ({
      page,
    }, testInfo) => {
      const alpha = await seedWorkspace({ repoPrefix: "filter-kept-", title: "Kept work" });
      const beta = await seedWorkspace({ repoPrefix: "filter-hidden-", title: "Hidden work" });
      const parent = await mkdtemp(path.join(tmpdir(), "filter-added-"));
      const client = await connectSeedClient();
      const serverId = getServerId();
      const alphaRow = page.getByTestId(`sidebar-project-row-${alpha.projectKey}`);
      const betaRow = page.getByTestId(`sidebar-project-row-${beta.projectKey}`);
      const projectName = method === "new-directory" ? "Created project" : path.basename(parent);
      let projectId: string | null = null;

      try {
        await gotoAppShell(page);
        await expect(alphaRow).toBeVisible({ timeout: 30_000 });
        await expect(betaRow).toBeVisible({ timeout: 30_000 });
        await openSidebarProjectFilter(page);
        await toggleProjectFilter(page, beta.projectKey);
        await closeSidebarDisplayPreferences(page);
        await expect(betaRow).toHaveCount(0);

        await openAddProjectFlow(page);
        await chooseAddProjectMethod(page, method);
        await addProjectFlowInput(page).fill(parent);
        await page.keyboard.press("Enter");
        if (method === "new-directory") {
          await expectAddProjectPage(page, "new-directory-name");
          await addProjectFlowInput(page).fill(projectName);
          await page.keyboard.press("Enter");
        }
        projectId = await expectOpenedProject(page);

        const addedRow = page
          .locator('[data-testid^="sidebar-project-row-"]')
          .filter({ hasText: projectName });
        await expect(addedRow).toBeVisible({ timeout: 30_000 });
        await expect(alphaRow).toBeVisible();
        await expect(betaRow).toHaveCount(0);

        await page.reload();
        await expect(addedRow).toBeVisible({ timeout: 30_000 });
        await expect(alphaRow).toBeVisible();
        await expect(betaRow).toHaveCount(0);
        await expect(
          page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`),
        ).toBeVisible();
        const addedRowId = await addedRow.getAttribute("data-testid");
        expect(addedRowId).not.toBeNull();
        const addedViewKey = addedRowId!.slice("sidebar-project-row-".length);
        await openSidebarProjectFilter(page);
        await expect(page.getByTestId(`sidebar-project-filter-${addedViewKey}`)).toHaveAttribute(
          "aria-checked",
          "true",
        );
        await expect(
          page.getByTestId(`sidebar-project-filter-${alpha.projectKey}`),
        ).toHaveAttribute("aria-checked", "true");
        await expect(page.getByTestId(`sidebar-project-filter-${beta.projectKey}`)).toHaveAttribute(
          "aria-checked",
          "false",
        );
        await page.screenshot({ path: testInfo.outputPath("project-selection.png") });
      } finally {
        if (projectId) await client.removeProject(projectId);
        await client.close();
        await rm(parent, { recursive: true, force: true });
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  }

  test("keeps the project selection when adding a missing directory fails", async ({ page }) => {
    const alpha = await seedWorkspace({ repoPrefix: "filter-kept-" });
    const beta = await seedWorkspace({ repoPrefix: "filter-hidden-" });
    const alphaRow = page.getByTestId(`sidebar-project-row-${alpha.projectKey}`);
    const betaRow = page.getByTestId(`sidebar-project-row-${beta.projectKey}`);

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible({ timeout: 30_000 });
      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, beta.projectKey);
      await closeSidebarDisplayPreferences(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "directory-search");
      await addProjectFlowInput(page).fill(path.join(alpha.repoPath, "missing-directory"));
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("add-project-flow-error")).toHaveText("Directory not found");
      await expectAddProjectPage(page, "directory-search");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0);
      await page.reload();
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toHaveCount(0);
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("hides projects independently across grouping, pins and reload", async ({
    page,
  }, testInfo) => {
    const alpha = await seedWorkspace({ repoPrefix: "visibility-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "visibility-beta-", title: "Beta work" });
    const gamma = await seedWorkspace({ repoPrefix: "visibility-gamma-", title: "Gamma work" });
    const row = (id: string) => page.getByTestId(`sidebar-workspace-row-${getServerId()}:${id}`);
    const choice = (key: string) => page.getByTestId(`sidebar-project-filter-${key}`);
    try {
      await gotoAppShell(page);
      await expect(row(alpha.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(row(beta.workspaceId)).toBeVisible();
      await expect(row(gamma.workspaceId)).toBeVisible();
      await openProjectPopover(page);
      for (const project of [alpha, beta, gamma]) {
        await expect(choice(project.projectKey)).toHaveAttribute("aria-checked", "true");
      }
      await closeSidebarDisplayPreferences(page);
      await row(alpha.workspaceId).click();
      await expect(page).toHaveURL(new RegExp(`/workspace/${alpha.workspaceId}`));
      const activeWorkspaceUrl = page.url();
      await openProjectContextMenu(page, alpha.projectKey);
      await expect(
        page.getByTestId(`sidebar-project-menu-remove-${alpha.projectKey}`),
      ).toBeVisible();
      // Capture the settled menu after its opening animation.
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath("wide-context.png") });
      await page.getByTestId(`sidebar-project-menu-hide-${alpha.projectKey}`).click();
      await expect(row(alpha.workspaceId)).toHaveCount(0);
      expect(page.url()).toBe(activeWorkspaceUrl);
      expect((await alpha.client.fetchWorkspaces()).entries.map((entry) => entry.id)).toContain(
        alpha.workspaceId,
      );
      await expect(row(beta.workspaceId)).toBeVisible();
      await expect(row(gamma.workspaceId)).toBeVisible();
      await openProjectPopover(page);
      await expect(choice(alpha.projectKey)).toHaveAttribute("aria-checked", "false");
      await expect(choice(beta.projectKey)).toHaveAttribute("aria-checked", "true");
      await expect(choice(gamma.projectKey)).toHaveAttribute("aria-checked", "true");
      await choice(alpha.projectKey).hover();
      // Capture the settled menu after its opening animation.
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath("wide-projects.png") });
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);
      await expect(row(alpha.workspaceId)).toBeVisible();
      await pinWorkspaceFromSidebar(page, alpha.workspaceId);
      await openProjectPopover(page);
      await toggleProjectFilter(page, alpha.projectKey);
      await toggleProjectFilter(page, beta.projectKey);
      await closeSidebarDisplayPreferences(page);
      await expect(row(alpha.workspaceId)).toHaveCount(0);
      await expect(row(beta.workspaceId)).toHaveCount(0);
      await expect(row(gamma.workspaceId)).toBeVisible();
      await selectSidebarStatusGrouping(page);
      await closeSidebarDisplayPreferences(page);
      await expect(row(alpha.workspaceId)).toHaveCount(0);
      await expect(row(beta.workspaceId)).toHaveCount(0);
      await expect(row(gamma.workspaceId)).toBeVisible();
      await page.reload();
      await expect(row(gamma.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(row(alpha.workspaceId)).toHaveCount(0);
      await expect(row(beta.workspaceId)).toHaveCount(0);
      await openProjectPopover(page);
      await toggleProjectFilter(page, gamma.projectKey);
      await closeSidebarDisplayPreferences(page);
      await expect(row(gamma.workspaceId)).toHaveCount(0);
      await openProjectPopover(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      for (const project of [alpha, beta, gamma])
        await expect(row(project.workspaceId)).toBeVisible();
    } finally {
      await gamma.cleanup();
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("keeps a project hidden after its host reconnects", async ({ page }) => {
    const host = await startIsolatedHostDaemon("project-visibility-reconnect");
    const project = await seedWorkspace({ repoPrefix: "visibility-reconnect-", port: host.port });
    const row = page.getByTestId(`sidebar-workspace-row-${host.serverId}:${project.workspaceId}`);
    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: host.serverId,
          label: "Visibility QA",
          endpoint: `127.0.0.1:${host.port}`,
        },
      ]);
      await gotoAppShell(page);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, project.projectKey);
      await closeSidebarDisplayPreferences(page);
      await expect(row).toHaveCount(0);
      const reconnected = page.waitForEvent("websocket", {
        predicate: (socket) => new URL(socket.url()).port === String(host.port),
        timeout: 30_000,
      });
      await host.restart();
      await reconnected;
      await openSidebarProjectFilter(page);
      await expect(
        page.getByTestId(`sidebar-project-filter-${project.projectKey}`),
      ).toHaveAttribute("aria-checked", "false", { timeout: 30_000 });
      await closeSidebarDisplayPreferences(page);
      await expect(row).toHaveCount(0);
      await expect(page.getByTestId("sidebar-filter-empty-state")).toBeVisible();
      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, project.projectKey);
      await closeSidebarDisplayPreferences(page);
      await expect(row).toBeVisible({ timeout: 30_000 });
    } finally {
      await project.cleanup();
      await host.close();
    }
  });

  test("keeps the single project reachable in compact menus", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const only = await seedWorkspace({ repoPrefix: "visibility-solo-", title: "Solo work" });
    const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${only.workspaceId}`);
    try {
      await gotoAppShell(page);
      await openMobileAgentSidebar(page);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await page.getByTestId(`sidebar-project-kebab-${only.projectKey}`).click();
      await expect(page.getByTestId(`sidebar-project-menu-hide-${only.projectKey}`)).toBeVisible();
      await expect(
        page.getByTestId(`sidebar-project-menu-remove-${only.projectKey}`),
      ).toBeVisible();
      // Capture the settled menu after its opening animation.
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath("compact-actions.png") });
      await page.getByTestId(`sidebar-project-menu-hide-${only.projectKey}`).click();
      await expect(row).toHaveCount(0);
      await expect(page.getByTestId("sidebar-filter-empty-state")).toBeVisible();
      await openSidebarProjectFilter(page);
      await expect(page.getByTestId(`sidebar-project-filter-${only.projectKey}`)).toHaveAttribute(
        "aria-checked",
        "false",
      );
      // Capture the settled menu after its opening animation.
      await page.waitForTimeout(600);
      await page.screenshot({ path: testInfo.outputPath("compact-projects.png") });
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(row).toBeVisible();
    } finally {
      await only.cleanup();
    }
  });
});
