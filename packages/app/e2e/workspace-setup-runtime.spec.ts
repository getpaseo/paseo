import { existsSync } from "node:fs";
import { expect, test } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { clickTerminal, waitForTabBar } from "./helpers/launcher";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  findWorktreeWorkspaceForProject,
  openHomeWithProject,
} from "./helpers/workspace-setup";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

async function navigateToWorkspaceViaSidebar(
  page: import("@playwright/test").Page,
  workspaceId: string,
): Promise<void> {
  const row = page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await waitForTabBar(page);
}

test.describe("Workspace setup runtime authority", () => {
  test.describe.configure({ retries: 1 });

  test("worktree workspace is created in its own directory", async ({ page }) => {
    test.setTimeout(90_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-setup-chat-");

    try {
      await client.openProject(repo.path);
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: `setup-chat-${Date.now()}`,
      });
      const workspaceId = workspace.id;

      const wsInfo = await findWorktreeWorkspaceForProject(client, repo.path);
      expect(wsInfo.workspaceDirectory).not.toBe(repo.path);
      expect(existsSync(wsInfo.workspaceDirectory)).toBe(true);

      // Navigate to the workspace via sidebar
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspaceId);
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("first terminal opens in the created workspace directory", async ({ page }) => {
    test.setTimeout(90_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-setup-terminal-");

    try {
      await client.openProject(repo.path);

      // Create workspace via daemon API since the new workspace screen
      // no longer has a standalone terminal button
      const worktreeSlug = `setup-terminal-${Date.now()}`;
      const result = await client.createPaseoWorktree({
        cwd: repo.path,
        worktreeSlug,
      });
      if (!result.workspace || result.error) {
        throw new Error(result.error ?? "Failed to create workspace");
      }
      const workspaceDir = result.workspace.workspaceDirectory;
      const workspaceId = result.workspace.id;

      // Navigate to the worktree workspace via sidebar click (direct URL
      // navigation for freshly created worktree workspaces can race with
      // Expo Router hydration, so we use the sidebar which is authoritative).
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspaceId);

      await clickTerminal(page);

      const terminal = page.locator('[data-testid="terminal-surface"]');
      await expect(terminal.first()).toBeVisible({ timeout: 20_000 });

      // Verify terminal is listed under the worktree directory, not the original repo
      await expect
        .poll(async () => (await client.listTerminals(workspaceDir)).terminals.length > 0, {
          timeout: 30_000,
        })
        .toBe(true);
      expect((await client.listTerminals(repo.path)).terminals.length).toBe(0);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
