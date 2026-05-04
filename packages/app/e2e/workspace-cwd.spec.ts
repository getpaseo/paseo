import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";
import { clickTerminal, waitForTabBar } from "./helpers/launcher";
import { setupDeterministicPrompt, waitForTerminalContent } from "./helpers/terminal-perf";
import { createTempGitRepo } from "./helpers/workspace";
import {
  connectWorkspaceSetupClient,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
} from "./helpers/workspace-setup";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

/** Navigate to a workspace via sidebar row testID and wait for tab bar. */
async function navigateToWorkspaceViaSidebar(
  page: import("@playwright/test").Page,
  workspaceId: string,
): Promise<void> {
  const testId = `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
  const row = page.getByTestId(testId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await waitForTabBar(page);
}

test.describe("Workspace cwd correctness", () => {
  test("main checkout workspace opens terminals in the project root", async ({ page }) => {
    test.setTimeout(60_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-cwd-main-");

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);

      const workspaceResult = await client.openProject(repo.path);
      if (!workspaceResult.workspace) {
        throw new Error(workspaceResult.error ?? `Failed to open project ${repo.path}`);
      }
      const workspaceId = workspaceResult.workspace.id;

      // Use sidebar navigation to avoid Expo Router hydration issues
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspaceId);
      await clickTerminal(page);

      const terminal = page.locator('[data-testid="terminal-surface"]');
      await expect(terminal.first()).toBeVisible({ timeout: 20_000 });
      await terminal.first().click();

      await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
      await terminal.first().pressSequentially("pwd\n", { delay: 0 });

      await waitForTerminalContent(page, (text) => text.includes(repo.path), 10_000);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("worktree workspace opens terminals in the worktree directory", async ({ page }) => {
    test.setTimeout(90_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-cwd-worktree-");
    const resolvedTmp = realpathSync("/tmp");
    const worktreePath = path.join(
      resolvedTmp,
      `paseo-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const branchName = `workspace-cwd-${Date.now()}`;
    let worktreeCreated = false;

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);

      execSync(
        `git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branchName)} main`,
        {
          cwd: repo.path,
          stdio: "ignore",
        },
      );
      worktreeCreated = true;

      const workspaceResult = await client.openProject(worktreePath);
      if (!workspaceResult.workspace) {
        throw new Error(workspaceResult.error ?? `Failed to open project ${worktreePath}`);
      }
      const workspaceId = workspaceResult.workspace.id;

      // Use sidebar navigation to avoid Expo Router hydration issues
      // with direct URL navigation to the 2nd+ workspace.
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspaceId);

      await clickTerminal(page);

      const terminal = page.locator('[data-testid="terminal-surface"]');
      await expect(terminal.first()).toBeVisible({ timeout: 20_000 });
      await terminal.first().click();

      await setupDeterministicPrompt(page, `PWD_READY_${Date.now()}`);
      await terminal.first().pressSequentially("pwd\n", { delay: 0 });
      await waitForTerminalContent(page, (text) => text.includes(worktreePath), 10_000);
    } finally {
      if (worktreeCreated) {
        try {
          execSync(`git worktree remove ${JSON.stringify(worktreePath)} --force`, {
            cwd: repo.path,
            stdio: "ignore",
          });
        } catch {
          // Best-effort cleanup so test failures preserve the original error.
        }
      }
      await client.close();
      await repo.cleanup();
    }
  });
});
