import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { getServerId } from "../support/helpers/server-id";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";

function workspaceKey(workspaceId: string): string {
  return `${getServerId()}:${workspaceId}`;
}

async function openKebabMenu(page: Page, workspaceId: string): Promise<void> {
  const key = workspaceKey(workspaceId);
  const row = page.getByTestId(`sidebar-workspace-row-${key}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.hover();

  const kebab = page.getByTestId(`sidebar-workspace-kebab-${key}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();
}

// "Mark as unread" is the manual inverse of "Mark as read": it re-uses the
// attention state for the sidebar dot and workspace status, but must never
// fire a notification. Focusing the workspace keeps clearing attention as
// before, so the round trip stays consistent with existing behavior.
test.describe("Sidebar workspace mark as unread", () => {
  test("kebab marks a workspace unread and read again", async ({ page }) => {
    const seeded = await seedMockAgentWorkspace({
      repoPrefix: "sidebar-mark-unread-",
      title: "Mark unread workspace",
    });

    try {
      // An agent that was never run sits in done with no attention.
      await seeded.client.waitForAgentUpsert(
        seeded.agentId,
        (snapshot) => snapshot.status === "idle",
      );
      await seeded.client.clearAgentAttention(seeded.agentId);

      await gotoAppShell(page);
      const key = workspaceKey(seeded.workspaceId);
      const row = page.getByTestId(`sidebar-workspace-row-${key}`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row.getByTestId("workspace-status-indicator-done")).toBeVisible({
        timeout: 30_000,
      });

      await openKebabMenu(page, seeded.workspaceId);
      const menuRenameItem = page.getByTestId(`sidebar-workspace-menu-rename-${key}`);
      await expect(menuRenameItem).toBeVisible({ timeout: 10_000 });
      await page.getByTestId(`sidebar-workspace-menu-mark-as-unread-${key}`).click();

      // Manual unread drives the same sidebar attention dot as lifecycle attention.
      await expect(row.getByTestId("workspace-status-indicator-attention")).toBeVisible({
        timeout: 30_000,
      });

      // The inverse action appears once attention is set.
      await openKebabMenu(page, seeded.workspaceId);
      await page.getByTestId(`sidebar-workspace-menu-mark-as-read-${key}`).click();

      await expect(row.getByTestId("workspace-status-indicator-done")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await seeded.cleanup();
    }
  });
});
