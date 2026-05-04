import { execSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { expect, test } from "./fixtures";
import { waitForTabBar } from "./helpers/launcher";
import { createTempGitRepo } from "./helpers/workspace";
import {
  createAgentChatFromLauncher,
  createStandaloneTerminalFromLauncher,
  expectTerminalCwd,
} from "./helpers/workspace-lifecycle";
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

/** Navigate to a workspace via sidebar row testID and wait for the tab bar. */
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

test.describe("Workspace lifecycle", () => {
  // The first test after a spec-file switch can intermittently fail because
  // the shared daemon still holds stale sessions from the previous spec.
  // One retry is enough for the daemon to stabilize.
  test.describe.configure({ retries: 1 });

  test.describe("Main checkout", () => {
    test("creates an agent chat via New Chat", async ({ page }) => {
      test.setTimeout(60_000);

      const client = await connectWorkspaceSetupClient();
      const repo = await createTempGitRepo("lifecycle-main-chat-");

      try {
        await seedProjectForWorkspaceSetup(client, repo.path);
        const workspaceResult = await client.openProject(repo.path);
        if (!workspaceResult.workspace) {
          throw new Error(workspaceResult.error ?? `Failed to open project ${repo.path}`);
        }
        const workspaceId = workspaceResult.workspace.id;

        await openHomeWithProject(page, repo.path);
        await navigateToWorkspaceViaSidebar(page, workspaceId);
        await createAgentChatFromLauncher(page);
      } finally {
        await client.close();
        await repo.cleanup();
      }
    });

    test("creates a terminal with correct CWD", async ({ page }) => {
      test.setTimeout(60_000);

      const client = await connectWorkspaceSetupClient();
      const repo = await createTempGitRepo("lifecycle-main-shell-");

      try {
        await seedProjectForWorkspaceSetup(client, repo.path);
        const workspaceResult = await client.openProject(repo.path);
        if (!workspaceResult.workspace) {
          throw new Error(workspaceResult.error ?? `Failed to open project ${repo.path}`);
        }
        const workspaceId = workspaceResult.workspace.id;

        await openHomeWithProject(page, repo.path);
        await navigateToWorkspaceViaSidebar(page, workspaceId);
        await createStandaloneTerminalFromLauncher(page);
        await expectTerminalCwd(page, repo.path);
      } finally {
        await client.close();
        await repo.cleanup();
      }
    });
  });

  test.describe("Worktree workspace", () => {
    test("creates an agent chat via New Chat", async ({ page }) => {
      test.setTimeout(90_000);

      const client = await connectWorkspaceSetupClient();
      const repo = await createTempGitRepo("lifecycle-wt-chat-");
      const resolvedTmp = realpathSync("/tmp");
      const worktreePath = path.join(
        resolvedTmp,
        `paseo-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const branchName = `lifecycle-wt-chat-${Date.now()}`;
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

        await openHomeWithProject(page, repo.path);
        await navigateToWorkspaceViaSidebar(page, workspaceId);
        await createAgentChatFromLauncher(page);
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

    test("creates a terminal with correct CWD", async ({ page }) => {
      test.setTimeout(90_000);

      const client = await connectWorkspaceSetupClient();
      const repo = await createTempGitRepo("lifecycle-wt-shell-");
      const resolvedTmp = realpathSync("/tmp");
      const worktreePath = path.join(
        resolvedTmp,
        `paseo-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      const branchName = `lifecycle-wt-shell-${Date.now()}`;
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

        await openHomeWithProject(page, repo.path);
        await navigateToWorkspaceViaSidebar(page, workspaceId);
        await createStandaloneTerminalFromLauncher(page);
        await expectTerminalCwd(page, worktreePath);
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
});
