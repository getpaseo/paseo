// Reported on 0.5.0-beta.1 desktop: after upgrading, the old docked explorer
// sidebar and the new explorer pane were both visible, and on Windows the
// sidebar had no close button because the window controls own that corner.
//
// The sidebar rendered off a persisted `desktop.fileExplorerOpen` flag that no
// migration cleared and that the rerouted explorer toggle no longer wrote. The
// explorer is now one surface per layout, so that flag must not resurrect it.
import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { waitForWorkspaceTabsVisible } from "../support/helpers/workspace-tabs";

function visible(page: Page, testId: string): Locator {
  return page.getByTestId(testId).filter({ visible: true });
}

function readPersistedPanelState(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("panel-state"));
}

function explorerSidebar(page: Page): Locator {
  return visible(page, "workspace-explorer-sidebar");
}

/** Seed exactly what a pre-pane build wrote after the user opened the sidebar once. */
async function seedRetiredSidebarState(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem(
      "panel-state",
      JSON.stringify({
        version: 14,
        state: {
          desktop: { agentListOpen: true, fileExplorerOpen: true, focusModeEnabled: false },
          explorerTab: "changes",
          explorerTabByCheckout: {},
          expandedPathsByWorkspace: {},
          diffCollapsedFoldersByWorkspace: {},
          collapsedFilePathsByWorkspace: {},
          sidebarWidth: 340,
          explorerWidth: 400,
          explorerSortOption: "name",
          explorerShowHiddenFiles: true,
          treeRailWidth: 320,
        },
      }),
    );
  });
}

test.describe("explorer surface after upgrading from the docked sidebar", () => {
  test("a persisted fileExplorerOpen flag no longer renders a second explorer", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-surface-upgrade-" });

    try {
      await seedRetiredSidebarState(page);
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      await test.step("the retired flag does not reveal Explorer", async () => {
        await expect(explorerSidebar(page)).toHaveCount(0);
        const toggle = visible(page, "workspace-explorer-toggle").first();
        await toggle.click();
        await expect(explorerSidebar(page)).toHaveCount(1, { timeout: 15_000 });
        await expect(explorerSidebar(page).getByTestId("explorer-sidebar-tab-files")).toBeVisible();
        await expect(
          explorerSidebar(page).getByTestId("explorer-sidebar-tab-changes_tree"),
        ).toBeVisible();

        await toggle.click();
        await expect(explorerSidebar(page)).toHaveCount(0, { timeout: 15_000 });
      });

      await test.step("the retired keys are migrated out of storage", async () => {
        const persisted = await readPersistedPanelState(page);
        expect(persisted).not.toBeNull();
        expect(persisted).not.toContain("fileExplorerOpen");
        expect(persisted).not.toContain("explorerWidth");
        // Everything else the user had must survive the migration.
        expect(persisted).toContain('"sidebarWidth":340');
      });
    } finally {
      await workspace.cleanup();
    }
  });

  test("toggle-both-sidebars closes and restores the agent list and the explorer", async ({
    page,
  }) => {
    const workspace = await seedWorkspace({ repoPrefix: "explorer-surface-both-" });
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    try {
      await gotoWorkspace(page, workspace.workspaceId);
      await waitForWorkspaceTabsVisible(page);

      const agentList = visible(page, "sidebar-sessions");
      const toggle = visible(page, "workspace-explorer-toggle").first();

      await test.step("open the explorer so both sides are showing", async () => {
        await toggle.click();
        await expect(explorerSidebar(page)).toHaveCount(1, { timeout: 15_000 });
        await expect(explorerSidebar(page).getByTestId("explorer-sidebar-tab-files")).toBeVisible();
        await expect(agentList).toHaveCount(1);
      });

      await test.step("the shortcut collapses both", async () => {
        await page.keyboard.press(`${modifier}+.`);
        await expect(explorerSidebar(page)).toHaveCount(0, { timeout: 15_000 });
        await expect(agentList).toHaveCount(0);
      });

      await test.step("the shortcut restores both", async () => {
        await page.keyboard.press(`${modifier}+.`);
        await expect(agentList).toHaveCount(1, { timeout: 15_000 });
        await expect(explorerSidebar(page)).toHaveCount(1, { timeout: 15_000 });
        await expect(explorerSidebar(page).getByTestId("explorer-sidebar-tab-files")).toBeVisible();
      });
    } finally {
      await workspace.cleanup();
    }
  });
});
