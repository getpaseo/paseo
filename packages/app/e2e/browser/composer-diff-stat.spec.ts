import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { ensureExplorerSidebar, openFilesPanel } from "../support/helpers/workspace-tabs";

const APP_SETTINGS_KEY = "@paseo:app-settings";

function visibleMainPane(page: Page) {
  return page.getByTestId("workspace-pane-main").filter({ visible: true });
}

function composerChangesPill(page: Page) {
  return page.getByTestId("composer-diff-stat-pill");
}

async function revealComposerChangesInExplorer(page: Page) {
  await composerChangesPill(page).click();

  const explorer = await ensureExplorerSidebar(page);
  await expect(explorer.getByTestId("changes-tree-panel")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
}

async function openComposerDiff(page: Page) {
  await composerChangesPill(page).click();
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

test("composer diff stat reveals Changes, then opens the diff in the configured side pane", async ({
  page,
}) => {
  await page.addInitScript((settingsKey) => {
    localStorage.setItem(settingsKey, JSON.stringify({ openInSidePane: { diffs: true } }));
  }, APP_SETTINGS_KEY);
  const workspace = await seedChangedAgent("composer-diff-stat-side-");

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const pill = composerChangesPill(page);
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toContainText("+2");
    await expect(pill).toContainText("-0");
    await revealComposerChangesInExplorer(page);
    await openComposerDiff(page);

    const sidePane = page
      .locator('[data-testid^="workspace-pane-"]')
      .filter({ visible: true })
      .filter({ has: page.getByTestId("working-diff-panel") });
    await expect(sidePane.getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(sidePane.getByTestId("working-diff-panel")).toBeVisible({ timeout: 30_000 });
    await expect(visibleMainPane(page).getByTestId("working-diff-panel")).toHaveCount(0);

    await test.step("Explorer navigation does not replace the side pane", async () => {
      await openFilesPanel(page);
      await expect(page.getByTestId("workspace-explorer-sidebar")).toContainText("Files");

      await pill.click();
      await expect(sidePane.getByTestId("working-diff-panel")).toBeVisible();
      await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(1);
    });
  } finally {
    await workspace.cleanup();
  }
});

test("composer diff stat opens the compact explorer instead of a Changes tab", async ({ page }) => {
  const workspace = await seedChangedAgent("composer-diff-stat-compact-");

  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    const closeExplorer = page
      .getByTestId("explorer-header")
      .getByRole("button", { name: "Close Explorer sidebar" });
    await expect(closeExplorer).not.toBeInViewport();

    await page.getByTestId("composer-diff-stat-pill").click();

    await expect(closeExplorer).toBeInViewport({ timeout: 30_000 });
    await expect(page.getByTestId("changes-header").filter({ visible: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId("workspace-tab-working_diff")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("composer diff stat reveals Changes, then opens the diff in the focused pane by default", async ({
  page,
}) => {
  const workspace = await seedChangedAgent("composer-diff-stat-tab-");

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await openAgentRoute(page, {
      workspaceId: workspace.workspaceId,
      agentId: workspace.agentId,
    });

    await revealComposerChangesInExplorer(page);
    await openComposerDiff(page);

    const mainPane = visibleMainPane(page);
    await expect(mainPane.getByTestId("workspace-tab-working_diff")).toBeVisible({
      timeout: 30_000,
    });
    await expect(mainPane.getByTestId("working-diff-panel")).toBeVisible({ timeout: 30_000 });
    await expect(
      page.locator('[data-testid^="workspace-pane-"]').filter({ visible: true }),
    ).toHaveCount(1);
  } finally {
    await workspace.cleanup();
  }
});
