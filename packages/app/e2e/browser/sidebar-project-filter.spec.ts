import { seedVisibleWorkspace as seedWorkspace } from "../support/helpers/mock-agent";
import { expect } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

import { getServerId } from "../support/helpers/server-id";
import {
  closeSidebarDisplayPreferences,
  openSidebarProjectFilter,
  pinWorkspaceFromSidebar,
  selectAllProjectsFilter,
  selectSidebarStatusGrouping,
  toggleProjectFilter,
} from "../support/helpers/sidebar";

test.describe("Sidebar project filter", () => {
  test.describe.configure({ timeout: 180_000 });

  test("pins the sidebar to one project across both grouping modes", async ({ page }) => {
    const alpha = await seedWorkspace({ repoPrefix: "project-filter-alpha-", title: "Alpha work" });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-beta-", title: "Beta work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);
    const betaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`);
    const filterTrigger = page.getByTestId("sidebar-display-project-filter");

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toBeVisible({ timeout: 30_000 });

      await openSidebarProjectFilter(page);
      await expect(page.getByTestId("sidebar-project-filter-all")).toBeVisible();
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toHaveCount(0, { timeout: 10_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(filterTrigger).toBeVisible();
      await expect(filterTrigger.getByTestId("menu-sub-indicator")).toBeVisible();
      await closeSidebarDisplayPreferences(page);

      await selectSidebarStatusGrouping(page);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toBeVisible({ timeout: 15_000 });
      await expect(betaRow).toHaveCount(0);

      await page.reload();
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });
      await expect(betaRow).toHaveCount(0);

      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(alphaRow).toBeVisible();
      await expect(betaRow).toBeVisible({ timeout: 15_000 });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("keeps the display menu reachable when the pinned section swallows the filtered project", async ({
    page,
  }) => {
    const alpha = await seedWorkspace({
      repoPrefix: "project-filter-pinned-",
      title: "Pinned work",
    });
    const beta = await seedWorkspace({ repoPrefix: "project-filter-other-", title: "Other work" });
    const serverId = getServerId();
    const alphaRow = page.getByTestId(`sidebar-workspace-row-${serverId}:${alpha.workspaceId}`);

    try {
      await gotoAppShell(page);
      await expect(alphaRow).toBeVisible({ timeout: 30_000 });

      await openSidebarProjectFilter(page);
      await toggleProjectFilter(page, alpha.projectKey);
      await closeSidebarDisplayPreferences(page);

      await pinWorkspaceFromSidebar(page, alpha.workspaceId);
      await expect(alphaRow).toBeVisible();

      await expect(page.getByTestId("sidebar-display-preferences-menu")).toBeVisible();
      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await closeSidebarDisplayPreferences(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${beta.workspaceId}`),
      ).toBeVisible({ timeout: 15_000 });
    } finally {
      await beta.cleanup();
      await alpha.cleanup();
    }
  });

  test("hides the filter row when there is only one project", async ({ page }) => {
    const only = await seedWorkspace({ repoPrefix: "project-filter-solo-", title: "Solo work" });
    const serverId = getServerId();

    try {
      await gotoAppShell(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${serverId}:${only.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible();
      await expect(page.getByTestId("sidebar-display-project-filter")).toHaveCount(0);
    } finally {
      await only.cleanup();
    }
  });
});
