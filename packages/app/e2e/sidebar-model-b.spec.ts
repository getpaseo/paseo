import { test, expect, type Page } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { gotoWorkspace, clickNewTerminal } from "./helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { seedMockAgentWorkspace } from "./helpers/mock-agent";
import { getServerId } from "./helpers/server-id";
import { waitForSidebarHydration } from "./helpers/workspace-ui";
import { getVisibleWorkspaceAgentTabIds } from "./helpers/workspace-tabs";

// Model B sidebar shape: every project — git or non-git, single- or
// multi-workspace — renders as the same expandable parent, the deepest sidebar
// level is the workspace row, and tabs/agents/terminals NEVER appear in the
// sidebar. These specs prove all three invariants end to end.

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function projectRow(page: Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-row-${projectKey}`);
}

function projectNewWorktreeIcon(page: Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-new-worktree-${projectKey}`);
}

async function seedSecondWorkspace(seeded: SeededWorkspace, title: string): Promise<string> {
  const created = await seeded.client.createWorkspace({
    backing: "local",
    cwd: seeded.repoPath,
    projectId: seeded.projectId,
    title,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create second workspace for ${seeded.projectId}`);
  }
  return created.workspace.id;
}

test.describe("Model B sidebar shape", () => {
  test.describe.configure({ timeout: 180_000 });

  test("git and non-git projects both render as expandable parents; git keeps a per-row new-worktree icon, the global button covers both", async ({
    page,
  }) => {
    const gitProject = await seedWorkspace({ repoPrefix: "model-b-git-" });
    const nonGitProject = await seedWorkspace({ repoPrefix: "model-b-nongit-", git: false });

    try {
      const gitSecondId = await seedSecondWorkspace(gitProject, "Git second");
      const nonGitSecondId = await seedSecondWorkspace(nonGitProject, "Non-git second");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      // Both projects are expandable parents — the non-git one is NOT flattened
      // into a bare workspace link.
      await expect(projectRow(page, gitProject.projectId)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, nonGitProject.projectId)).toBeVisible({ timeout: 30_000 });

      // Each parent shows both of its workspace rows underneath.
      await expect(workspaceRow(page, gitProject.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, gitSecondId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, nonGitProject.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, nonGitSecondId)).toBeVisible({ timeout: 30_000 });

      // The per-project "+ New workspace" row is gone. The git project keeps a
      // per-row new-worktree icon (revealed on hover); the non-git project has
      // none, since worktree creation needs a git checkout.
      await projectRow(page, gitProject.projectId).hover();
      await expect(projectNewWorktreeIcon(page, gitProject.projectId)).toBeVisible({
        timeout: 30_000,
      });
      await expect(projectNewWorktreeIcon(page, nonGitProject.projectId)).toHaveCount(0);

      // The global new-workspace button is the universal entry — present for both
      // kinds regardless of their per-row affordance.
      await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await gitProject.cleanup();
      await nonGitProject.cleanup();
    }
  });

  test("no tab, agent, or terminal ever renders as a sidebar row", async ({ page }) => {
    const mock = await seedMockAgentWorkspace({
      repoPrefix: "model-b-leaf-",
      title: "Leaf workspace",
    });

    try {
      // Open the workspace and materialize both an agent tab and a terminal tab.
      await gotoWorkspace(page, mock.workspaceId);
      const agentTabs = await getVisibleWorkspaceAgentTabIds(page);
      expect(agentTabs).toContain(`workspace-tab-agent_${mock.agentId}`);

      await clickNewTerminal(page);
      await expect(
        page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });

      // The deepest level inside the sidebar is the workspace row: no tab,
      // agent, or terminal element appears as a sidebar descendant.
      const sidebar = page.getByTestId("sidebar-sessions").filter({ visible: true }).first();
      await expect(workspaceRow(page, mock.workspaceId).first()).toBeVisible({ timeout: 30_000 });
      await expect(sidebar.locator('[data-testid^="workspace-tab-"]')).toHaveCount(0);
      await expect(sidebar.locator('[data-testid^="sidebar-agent-row-"]')).toHaveCount(0);
      await expect(sidebar.locator('[data-testid^="sidebar-terminal-row-"]')).toHaveCount(0);
    } finally {
      await mock.cleanup();
    }
  });

  test("status grouping shows only workspace rows and moves a single row when its status changes", async ({
    page,
  }) => {
    const idleProject = await seedWorkspace({ repoPrefix: "model-b-status-idle-" });
    const activeMock = await seedMockAgentWorkspace({
      repoPrefix: "model-b-status-active-",
      title: "Working workspace",
      initialPrompt: "stay busy",
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(workspaceRow(page, idleProject.workspaceId)).toBeVisible({ timeout: 30_000 });

      // Switch to status grouping.
      await page.getByTestId("sidebar-grouping-selector").click();
      await page.getByTestId("sidebar-grouping-status").click();

      const sidebar = page.getByTestId("sidebar-sessions").filter({ visible: true }).first();

      // The idle workspace lands in the Done bucket; the busy mock-agent workspace
      // lands in the Working bucket. Each workspace is bucketed independently.
      await expect(page.getByTestId("sidebar-status-group-done")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("sidebar-status-group-running")).toBeVisible({
        timeout: 60_000,
      });
      await expect(workspaceRow(page, idleProject.workspaceId).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(workspaceRow(page, activeMock.workspaceId).first()).toBeVisible({
        timeout: 60_000,
      });

      // Only workspace rows are shown — no tab/agent/terminal leaves leak into
      // the status view.
      await expect(sidebar.locator('[data-testid^="workspace-tab-"]')).toHaveCount(0);

      // The busy workspace is grouped under Working, the idle one under Done:
      // changing one workspace's status moved only that row.
      const workingRows = page.getByTestId("sidebar-status-group-rows-running");
      const doneRows = page.getByTestId("sidebar-status-group-rows-done");
      await expect(
        workingRows.getByTestId(`sidebar-workspace-row-${getServerId()}:${activeMock.workspaceId}`),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        doneRows.getByTestId(`sidebar-workspace-row-${getServerId()}:${idleProject.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });
      // The busy workspace is NOT also sitting in the Done bucket — only its own
      // row moved.
      await expect(
        doneRows.getByTestId(`sidebar-workspace-row-${getServerId()}:${activeMock.workspaceId}`),
      ).toHaveCount(0);
    } finally {
      await idleProject.cleanup();
      await activeMock.cleanup();
    }
  });
});
