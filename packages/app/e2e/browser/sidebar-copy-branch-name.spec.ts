import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { copyBranchNameFromSidebar, selectSidebarStatusGrouping } from "../support/helpers/sidebar";

async function readClipboard(page: Page): Promise<string> {
  return page.evaluate(() => navigator.clipboard.readText());
}

// The sidebar has one row implementation per grouping mode, and each one wires the menu's
// copy action itself. The status-grouped row copied the workspace name — which the daemon
// resolves to the custom title whenever one is set — so the seeded title here must differ
// from the branch. A workspace whose title still matches its branch passes either way.
test.describe("Sidebar copy branch name", () => {
  test("copies the branch, not the title, from a status-grouped row", async ({ context, page }) => {
    const customTitle = "Payments Refactor";
    const workspace = await seedWorkspace({
      repoPrefix: "sidebar-copy-branch-",
      title: customTitle,
    });

    try {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await gotoAppShell(page);

      const row = page.getByTestId(
        `sidebar-workspace-row-${getServerId()}:${workspace.workspaceId}`,
      );
      await expect(row).toContainText(customTitle, { timeout: 30_000 });

      await selectSidebarStatusGrouping(page);
      await copyBranchNameFromSidebar(page, workspace.workspaceId);

      // createTempGitRepo seeds `git init -b main` and leaves HEAD on main.
      await expect.poll(() => readClipboard(page)).toBe("main");
    } finally {
      await workspace.cleanup();
    }
  });
});
