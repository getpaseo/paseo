import { expect } from "@playwright/test";
import { test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  addOfflineHostAndReload,
  expectHostFilterRow,
  openSidebarDisplayPreferences,
  selectAllHostsFilter,
  toggleHostFilter,
} from "./helpers/hosts";
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
      await gotoAppShell(page);
      await addOfflineHostAndReload(page, { serverId: SECONDARY_HOST_ID, label: "Secondary Host" });
      await expect(workspaceRow).toBeVisible({ timeout: 30_000 });

      await openSidebarDisplayPreferences(page);
      await expectHostFilterRow(page, serverId);
      await expectHostFilterRow(page, SECONDARY_HOST_ID);

      // Pin the primary host — its workspace stays visible.
      await toggleHostFilter(page, serverId);
      await expect(workspaceRow).toBeVisible();

      // Add the secondary host without clearing the primary. Under single-select this would replace
      // the primary and hide the workspace; multi-select keeps both pinned, so it stays visible.
      await toggleHostFilter(page, SECONDARY_HOST_ID);
      await expect(workspaceRow).toBeVisible();

      // Drop the primary host — only the (empty) secondary host remains pinned, so the workspace hides.
      await toggleHostFilter(page, serverId);
      await expect(workspaceRow).toHaveCount(0, { timeout: 10_000 });

      // Back to all hosts — the workspace returns.
      await selectAllHostsFilter(page);
      await expect(workspaceRow).toBeVisible({ timeout: 10_000 });
    } finally {
      await seeded.cleanup();
    }
  });
});
