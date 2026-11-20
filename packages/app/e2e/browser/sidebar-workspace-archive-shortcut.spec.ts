import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";

// The archive shortcut used to be registered by the sidebar row itself, so it did nothing whenever
// the row was unmounted — a collapsed project section being the common case. It now lives in a
// single always-mounted handler keyed on the active route selection, like the pin shortcut.
const ARCHIVE_SHORTCUT = "ControlOrMeta+Shift+Backspace";

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

// Returns the workspace route, so the test can assert archiving redirected off it.
async function openWorkspace(page: Page, workspaceId: string): Promise<string> {
  const row = workspaceRow(page, workspaceId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
  return page.url();
}

async function collapseProjectSection(page: Page, project: SeededWorkspace): Promise<void> {
  const header = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: project.projectDisplayName });
  await expect(header).toHaveCount(1, { timeout: 30_000 });

  await header.click();
  await expect(workspaceRow(page, project.workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

async function collapseStatusGroupContaining(page: Page, workspaceId: string): Promise<void> {
  const rows = page
    .locator('[data-testid^="sidebar-status-group-rows-"]')
    .filter({ has: workspaceRow(page, workspaceId) });
  await expect(rows).toHaveCount(1, { timeout: 30_000 });

  const rowsTestId = await rows.getAttribute("data-testid");
  const bucket = rowsTestId?.replace("sidebar-status-group-rows-", "");
  expect(bucket).toBeTruthy();

  await page.getByTestId(`sidebar-status-group-${bucket}`).click();
  await expect(workspaceRow(page, workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

// Archiving the active workspace redirects off its route, and the row stays gone after a reload,
// which only holds once the daemon has recorded the archive.
async function expectArchived(page: Page, workspaceId: string, workspaceUrl: string) {
  await expect.poll(() => page.url(), { timeout: 10_000 }).not.toBe(workspaceUrl);
  await page.reload();
  await gotoAppShell(page);
  await expect(workspaceRow(page, workspaceId)).toHaveCount(0, { timeout: 10_000 });
}

test.describe("Archive workspace shortcut", () => {
  test("archives the active workspace while its row is rendered", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-expanded-" });

    try {
      await gotoAppShell(page);
      const workspaceUrl = await openWorkspace(page, workspace.workspaceId);

      await page.keyboard.press(ARCHIVE_SHORTCUT);

      await expectArchived(page, workspace.workspaceId, workspaceUrl);
    } finally {
      await workspace.cleanup();
    }
  });

  test("archives the active workspace while its project section is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-collapsed-" });

    try {
      await gotoAppShell(page);
      const workspaceUrl = await openWorkspace(page, workspace.workspaceId);
      await collapseProjectSection(page, workspace);

      await page.keyboard.press(ARCHIVE_SHORTCUT);

      await expectArchived(page, workspace.workspaceId, workspaceUrl);
    } finally {
      await workspace.cleanup();
    }
  });

  test("archives the active workspace while its status group is collapsed", async ({ page }) => {
    const workspace = await seedWorkspace({ repoPrefix: "archive-shortcut-status-" });

    try {
      await gotoAppShell(page);
      const workspaceUrl = await openWorkspace(page, workspace.workspaceId);
      await selectSidebarStatusGrouping(page);
      await expect(page.getByTestId("sidebar-status-list-scroll")).toBeVisible({
        timeout: 10_000,
      });
      await collapseStatusGroupContaining(page, workspace.workspaceId);

      await page.keyboard.press(ARCHIVE_SHORTCUT);

      await expectArchived(page, workspace.workspaceId, workspaceUrl);
    } finally {
      await workspace.cleanup();
    }
  });
});
