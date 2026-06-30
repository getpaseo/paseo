import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { appendOfflineHost } from "./helpers/hosts";
import { seedWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";

const SECONDARY_HOST_ID = "host-filter-secondary";

test.describe("Sidebar host filter (multi-select)", () => {
  test.describe.configure({ timeout: 120_000 });

  test("pins the sidebar to multiple selected hosts at once", async ({ page }) => {
    const seeded = await seedWorkspace({ repoPrefix: "host-filter-" });
    const serverId = getServerId();
    const workspaceRow = page.getByTestId(
      `sidebar-workspace-row-${serverId}:${seeded.workspaceId}`,
    );

    try {
      // A second (offline) host is enough to surface the host filter without a second daemon.
      await appendOfflineHost(page, { serverId: SECONDARY_HOST_ID, label: "Secondary Host" });
      await gotoAppShell(page);

      await expect(workspaceRow).toBeVisible({ timeout: 30_000 });

      await page.getByTestId("sidebar-display-preferences-menu").click();
      await expect(page.getByTestId("sidebar-display-preferences-content")).toBeVisible({
        timeout: 10_000,
      });

      // The filter section lists "All hosts" plus a row per host, each with a status dot on the left.
      await expect(page.getByTestId("sidebar-host-filter-all")).toBeVisible();
      await expect(page.getByTestId(`sidebar-host-filter-${serverId}`)).toBeVisible();
      await expect(page.getByTestId(`sidebar-host-filter-${SECONDARY_HOST_ID}`)).toBeVisible();
      await expect(page.getByTestId(`sidebar-host-filter-status-${serverId}`)).toBeVisible();
      await expect(
        page.getByTestId(`sidebar-host-filter-status-${SECONDARY_HOST_ID}`),
      ).toBeVisible();

      // Pin the primary host — its workspace stays visible.
      await page.getByTestId(`sidebar-host-filter-${serverId}`).click();
      await expect(workspaceRow).toBeVisible();

      // Add the secondary host without clearing the primary. Under single-select this would replace
      // the primary and hide the workspace; multi-select keeps both pinned, so it stays visible.
      await page.getByTestId(`sidebar-host-filter-${SECONDARY_HOST_ID}`).click();
      await expect(workspaceRow).toBeVisible();

      // Drop the primary host — only the (empty) secondary host remains pinned, so the workspace hides.
      await page.getByTestId(`sidebar-host-filter-${serverId}`).click();
      await expect(workspaceRow).toHaveCount(0, { timeout: 10_000 });

      // Back to all hosts — the workspace returns.
      await page.getByTestId("sidebar-host-filter-all").click();
      await expect(workspaceRow).toBeVisible({ timeout: 10_000 });
    } finally {
      await seeded.cleanup();
    }
  });
});
