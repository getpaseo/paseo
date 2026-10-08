import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import { clickNewTerminal } from "../support/helpers/launcher";
import { expectTerminalSurfaceVisible } from "../support/helpers/terminal-perf";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  expectSetupPanel,
  expectSetupStatus,
  fetchWorkspaceById,
  findWorktreeWorkspaceForProject,
  navigateToWorkspaceViaSidebar,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "../support/helpers/workspace-setup";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";

test.describe("Workspace setup runtime authority", () => {
  test.describe.configure({ retries: 1 });

  test("refreshes setup completed while the browser was disconnected", async ({ page }) => {
    test.setTimeout(90_000);
    const gate = await installDaemonWebSocketGate(page);
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-setup-reconnect-", {
      paseoConfig: { worktree: { setup: "node setup.cjs" } },
      files: [
        {
          path: "setup.cjs",
          content: `const { existsSync } = require("node:fs");
console.log("Waiting for setup release");
const timer = setInterval(() => {
  if (existsSync("allow-setup")) {
    clearInterval(timer);
    console.log("Setup finished");
  }
}, 20);
`,
        },
      ],
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "setup-reconnect",
      });
      const descriptor = await fetchWorkspaceById(client, workspace.id);
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspace.id);
      await expectSetupPanel(page);
      await expectSetupStatus(page, "Running");

      await gate.drop();
      await gate.waitForBlockedConnection();
      const completed = waitForWorkspaceSetupProgress(
        client,
        (progress) => progress.workspaceId === workspace.id && progress.status === "completed",
      );
      await writeFile(path.join(descriptor.workspaceDirectory, "allow-setup"), "ok\n");
      await completed;
      await expectSetupStatus(page, "Running");

      gate.restore();
      await expectSetupStatus(page, "Completed");
    } finally {
      gate.restore();
      await client.close();
      await repo.cleanup();
    }
  });

  test("worktree workspace is created in its own directory", async ({ page }) => {
    test.setTimeout(90_000);

    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("workspace-setup-chat-");

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
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
      await seedProjectForWorkspaceSetup(client, repo.path);

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
