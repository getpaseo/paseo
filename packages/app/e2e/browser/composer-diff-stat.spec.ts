import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { openFilesPanel } from "../support/helpers/workspace-tabs";

const APP_SETTINGS_KEY = "@paseo:app-settings";

function visibleMainPane(page: Page) {
  return page.getByTestId("workspace-pane-main").filter({ visible: true });
}

async function seedChangedAgent(repoPrefix: string) {
  const workspace = await seedMockAgentWorkspace({
    repoPrefix,
    title: "Composer diff stat",
    repo: { withRemote: true },
  });
  try {
    await rm(path.join(workspace.cwd, "remote.git"), { recursive: true });
    await writeFile(
      path.join(workspace.cwd, "README.md"),
      "# Temp Repo\nexport const one = 1;\nexport const two = 2;\n",
    );
    await workspace.client.checkoutRefresh(workspace.cwd);
    await expect
      .poll(async () => {
        const workspaces = await workspace.client.fetchWorkspaces();
        return (
          workspaces.entries.find((entry) => entry.id === workspace.workspaceId)?.diffStat ?? null
        );
      })
      .toEqual({ additions: 2, deletions: 0 });
    return workspace;
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

test("composer diff stat toggles Changes in the preferred Side panel", async ({ page }) => {
  const workspace = await seedChangedAgent("composer-diff-stat-side-");

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const pill = page.getByTestId("composer-diff-stat-pill");
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toContainText("+2");
    await expect(pill).toContainText("-0");
    await pill.click();

    const sidePanel = page.getByTestId("workspace-side-panel").filter({ visible: true });
    await expect(sidePanel.getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(sidePanel.getByTestId("working-diff-panel")).toBeVisible({ timeout: 30_000 });

    await test.step("switching from another Side panel view reveals Changes", async () => {
      await openFilesPanel(page);
      await expect(sidePanel.getByTestId("file-explorer-tree-scroll")).toBeVisible();

      await pill.click();
      await expect(sidePanel.getByTestId("working-diff-panel")).toBeVisible();
    });

    await test.step("clicking visible Changes hides the panel without closing its tab", async () => {
      await pill.click();
      await expect(sidePanel).toHaveCount(0);
      await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(1);
    });

    await test.step("clicking again restores Changes", async () => {
      await pill.click();
      await expect(sidePanel.getByTestId("workspace-tab-working_diff")).toBeVisible();
      await expect(sidePanel.getByTestId("working-diff-panel")).toBeVisible();
    });
  } finally {
    await workspace.cleanup();
  }
});

test("composer diff stat opens Changes in the focused pane when Side panel routing is off", async ({
  page,
}) => {
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ openSupportingTabsInSidePanel: false }));
  }, APP_SETTINGS_KEY);
  const workspace = await seedChangedAgent("composer-diff-stat-tab-");

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    await page.getByTestId("composer-diff-stat-pill").click();

    const mainPane = visibleMainPane(page);
    await expect(mainPane.getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(mainPane.getByTestId("working-diff-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("workspace-side-panel")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
