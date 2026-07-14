import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  addOfflineHostAndReload,
  openSidebarDisplayPreferences,
  toggleHostFilter,
} from "./helpers/hosts";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

const OFFLINE_HOST_ID = "sidebar-organization-offline";

function scrollMenuToEnd(surface: HTMLElement) {
  const candidates = [surface, ...surface.querySelectorAll<HTMLElement>("*")];
  for (const candidate of candidates) {
    if (candidate.scrollHeight <= candidate.clientHeight) continue;
    candidate.scrollTop = candidate.scrollHeight;
    return { clientHeight: candidate.clientHeight, scrollHeight: candidate.scrollHeight };
  }
  return null;
}

test.describe("Sidebar organization menu", () => {
  test.describe.configure({ timeout: 120_000 });

  test("keeps host-backed options unavailable until the selected host reports support", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "sidebar-offline-capabilities-" });
    try {
      await gotoAppShell(page);
      await addOfflineHostAndReload(page, {
        serverId: OFFLINE_HOST_ID,
        label: "Offline organization host",
      });
      await waitForSidebarHydration(page);

      await openSidebarDisplayPreferences(page);
      await page.getByTestId("sidebar-organization-page-host").click();
      await toggleHostFilter(page, OFFLINE_HOST_ID);
      await page.keyboard.press("Escape");

      await openSidebarDisplayPreferences(page);
      await expect(page.getByTestId("sidebar-new-workspace-collection")).toBeDisabled();
      await page.getByTestId("sidebar-organization-page-group").click();
      await expect(page.getByTestId("sidebar-grouping-collection")).toBeDisabled();
      await page.keyboard.press("Escape");

      await openSidebarDisplayPreferences(page);
      await page.getByTestId("sidebar-organization-page-sort").click();
      await expect(page.getByTestId("sidebar-sort-created")).toBeDisabled();
      await expect(page.getByTestId("sidebar-sort-recency")).toBeDisabled();
    } finally {
      await workspace.cleanup();
    }
  });

  test("keeps a long project filter page bounded and scrollable", async ({ page }) => {
    const workspaces: SeededWorkspace[] = [];
    try {
      for (let index = 0; index < 14; index += 1) {
        workspaces.push(
          await seedWorkspace({
            repoPrefix: `zz-sidebar-menu-scroll-${String(index).padStart(2, "0")}-`,
            git: false,
          }),
        );
      }
      const lastWorkspace = workspaces.at(-1);
      if (!lastWorkspace) throw new Error("Expected seeded workspaces");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openSidebarDisplayPreferences(page);
      await page.getByTestId("sidebar-organization-page-project").click();

      const menu = page.getByTestId("sidebar-display-preferences-content");
      const target = page.getByTestId(`sidebar-project-filter-${lastWorkspace.projectId}`);
      await expect(target).toHaveCount(1);

      const metrics = await menu.evaluate(scrollMenuToEnd);

      expect(metrics).not.toBeNull();
      expect(metrics?.clientHeight).toBeLessThanOrEqual(480);
      expect(metrics?.scrollHeight).toBeGreaterThan(metrics?.clientHeight ?? 0);
      await expect(target).toBeInViewport();
      await target.click();
    } finally {
      await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
    }
  });
});
