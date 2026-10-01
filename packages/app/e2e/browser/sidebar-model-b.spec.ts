import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { gotoWorkspace, clickNewTerminal } from "../support/helpers/launcher";
import { type SeededWorkspace } from "../support/helpers/seed-client";
import {
  ensureWorkspaceHasContent,
  seedMockAgentWorkspace,
  seedVisibleWorkspace as seedWorkspace,
} from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { projectEquivalenceViewKey } from "../support/helpers/project-view-key";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { waitForSidebarHydration } from "../support/helpers/workspace-ui";

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

function projectRow(page: Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-row-${projectEquivalenceViewKey(projectKey)}`);
}

function projectNewWorktreeIcon(page: Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-new-worktree-${projectEquivalenceViewKey(projectKey)}`);
}

async function seedSecondWorkspace(seeded: SeededWorkspace, title: string): Promise<string> {
  const created = await seeded.client.createWorkspace({
    source: { kind: "directory", path: seeded.repoPath, projectId: seeded.projectId },
    title,
  });
  if (!created.workspace) {
    throw new Error(created.error ?? `Failed to create second workspace for ${seeded.projectId}`);
  }
  await ensureWorkspaceHasContent(
    seeded.client,
    created.workspace.id,
    created.workspace.workspaceDirectory,
  );
  return created.workspace.id;
}

test.describe("Model B sidebar shape", () => {
  test.describe.configure({ timeout: 180_000 });

  test("git and non-git projects both render as expandable parents, both show a per-row New workspace icon, and the global button covers both", async ({
    page,
  }) => {
    const gitProject = await seedWorkspace({ repoPrefix: "model-b-git-" });
    const nonGitProject = await seedWorkspace({ repoPrefix: "model-b-nongit-", git: false });

    try {
      const gitSecondId = await seedSecondWorkspace(gitProject, "Git second");
      const nonGitSecondId = await seedSecondWorkspace(nonGitProject, "Non-git second");

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await expect(projectRow(page, gitProject.projectKey)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, nonGitProject.projectKey)).toBeVisible({ timeout: 30_000 });

      await expect(workspaceRow(page, gitProject.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, gitSecondId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, nonGitProject.workspaceId)).toBeVisible({ timeout: 30_000 });
      await expect(workspaceRow(page, nonGitSecondId)).toBeVisible({ timeout: 30_000 });

      await projectRow(page, gitProject.projectKey).hover();
      await expect(projectNewWorktreeIcon(page, gitProject.projectKey)).toBeVisible({
        timeout: 30_000,
      });
      await projectRow(page, nonGitProject.projectKey).hover();
      await expect(projectNewWorktreeIcon(page, nonGitProject.projectKey)).toBeVisible({
        timeout: 30_000,
      });

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
      await gotoWorkspace(page, mock.workspaceId);
      await expect(
        page.getByTestId(`workspace-tab-agent_${mock.agentId}`).filter({ visible: true }),
      ).toBeVisible();

      await clickNewTerminal(page);
      await expect(
        page.locator('[data-testid^="workspace-tab-terminal_"]').filter({ visible: true }).first(),
      ).toBeVisible({ timeout: 30_000 });

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
      model: "one-minute-stream",
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(workspaceRow(page, idleProject.workspaceId)).toBeVisible({ timeout: 30_000 });

      await selectSidebarStatusGrouping(page);

      const sidebar = page.getByTestId("sidebar-sessions").filter({ visible: true }).first();

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
      await expect(workspaceRow(page, idleProject.workspaceId).first()).toHaveAccessibleName(
        `${idleProject.projectDisplayName}, ${idleProject.workspaceName}`,
      );
      await expect(workspaceRow(page, activeMock.workspaceId).first()).toHaveAccessibleName(
        /Working$/,
      );

      await expect(sidebar.locator('[data-testid^="workspace-tab-"]')).toHaveCount(0);

      for (const workspaceId of [idleProject.workspaceId, activeMock.workspaceId]) {
        await expect(
          page.getByTestId(`sidebar-row-project-icon-${getServerId()}:${workspaceId}`).first(),
        ).toBeVisible({ timeout: 60_000 });
      }

      const workingRows = page.getByTestId("sidebar-status-group-rows-running");
      const doneRows = page.getByTestId("sidebar-status-group-rows-done");
      await expect(
        workingRows.getByTestId(`sidebar-workspace-row-${getServerId()}:${activeMock.workspaceId}`),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        doneRows.getByTestId(`sidebar-workspace-row-${getServerId()}:${idleProject.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await expect(
        doneRows.getByTestId(`sidebar-workspace-row-${getServerId()}:${activeMock.workspaceId}`),
      ).toHaveCount(0);
    } finally {
      await idleProject.cleanup();
      await activeMock.cleanup();
    }
  });
});
