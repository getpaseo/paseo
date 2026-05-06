import { existsSync } from "node:fs";
import { expect, test } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { clickNewTerminal } from "./helpers/launcher";
import { expectTerminalSurfaceVisible } from "./helpers/terminal-perf";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  findWorktreeWorkspaceForProject,
  navigateToWorkspaceViaSidebar,
  openHomeWithProject,
} from "./helpers/workspace-setup";

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

      await clickNewTerminal(page);
      await expectTerminalSurfaceVisible(page);

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
