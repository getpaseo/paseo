import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import {
  waitForWorkspaceTabsVisible,
  expectNoTerminalTabs,
  clickFirstTerminalTab,
  expectFirstTerminalTabContains,
} from "./helpers/workspace-tabs";
import { clickNewChat } from "./helpers/launcher";
import { expectComposerVisible } from "./helpers/composer";
import { openFileExplorer, expectExplorerEntryVisible } from "./helpers/file-explorer";
import { expectTerminalSurfaceVisible, waitForTerminalAttached } from "./helpers/terminal-perf";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  expectSetupPanel,
  openHomeWithProject,
  navigateToWorkspaceViaSidebar,
  openWorkspaceScriptsMenu,
  startWorkspaceScriptFromMenu,
  closeWorkspaceScriptsMenu,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "./helpers/workspace-setup";

interface WorkspaceScriptStarter {
  startWorkspaceScript(
    workspaceId: string,
    scriptName: string,
  ): Promise<{
    workspaceId: string;
    scriptName: string;
    terminalId: string | null;
    error: string | null;
  }>;
}

test.describe("Workspace setup streaming", () => {
  test("opens the setup tab when a workspace is created from the sidebar", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-open-", {
      paseoConfig: {
        worktree: {
          setup: [
            "sh -c 'echo starting setup; for i in $(seq 1 30); do echo tick $i; sleep 1; done; echo setup complete'",
          ],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: `setup-open-${Date.now()}`,
      });
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspace.id);

      await expectSetupPanel(page);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("runs setup through the sidebar and leaves the workspace usable", async ({ page }) => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-ui-flow-", {
      paseoConfig: {
        worktree: {
          setup: [
            "sh -c 'echo starting setup; sleep 1; echo loading dependencies; sleep 1; echo setup complete'",
          ],
        },
      },
      files: [{ path: "src/index.ts", content: "export const ready = true;\n" }],
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);

      // Wait for setup completion via daemon (setup snapshots are per-session,
      // so the browser session won't receive progress events).
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: `setup-ui-flow-${Date.now()}`,
      });
      await completed;

      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspace.id);

      await waitForWorkspaceTabsVisible(page);
      await clickNewChat(page);
      await expectComposerVisible(page, { timeout: 30_000 });
      await openFileExplorer(page);
      await expectExplorerEntryVisible(page, "README.md");
      await expectExplorerEntryVisible(page, "src");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("streams running and completed setup snapshots for a successful setup", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-success-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup complete'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const initialRunning = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "running" && payload.detail.log === "",
      );
      const runningWithOutput = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "running" && payload.detail.log.includes("starting setup"),
      );
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-success",
      });

      const initialPayload = await initialRunning;
      const runningPayload = await runningWithOutput;
      const completedPayload = await completed;

      expect(initialPayload.detail.log).toBe("");
      expect(runningPayload.detail.log).toContain("starting setup");
      expect(completedPayload.detail.log).toContain("setup complete");
      expect(completedPayload.error).toBeNull();
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("streams a failed setup snapshot when setup fails", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-failure-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo starting setup; sleep 2; echo setup failed 1>&2; exit 1'"],
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const failed = waitForWorkspaceSetupProgress(
        client,
        (payload) => payload.status === "failed" && payload.detail.log.includes("setup failed"),
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-failure",
      });

      const failedPayload = await failed;
      expect(failedPayload.detail.log).toContain("starting setup");
      expect(failedPayload.detail.log).toContain("setup failed");
      expect(failedPayload.error).toMatch(/failed/i);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("emits a completed empty snapshot when no setup commands exist", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-none-");

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" &&
          payload.detail.commands.length === 0 &&
          payload.detail.log === "",
      );

      await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: "workspace-setup-none",
      });

      const completedPayload = await completed;
      expect(completedPayload.error).toBeNull();
      expect(completedPayload.detail.commands).toEqual([]);
      expect(completedPayload.detail.log).toBe("");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("launches script terminals from the workspace scripts menu", async ({ page }) => {
    test.setTimeout(90_000);
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-svc-ui-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo bootstrapping; sleep 1; echo setup complete'"],
        },
        scripts: {
          web: {
            command:
              "node -e \"const http = require('http'); const s = http.createServer((q,r) => r.end('ok')); s.listen(process.env.PORT || 3000, () => console.log('listening on ' + s.address().port))\"",
          },
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);

      // Wait for setup completion via daemon (setup snapshots are per-session)
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );
      const workspace = await createWorkspaceThroughDaemon(client, {
        cwd: repo.path,
        worktreeSlug: `setup-svc-${Date.now()}`,
      });
      await completed;

      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspace.id);

      await waitForWorkspaceTabsVisible(page);
      await expectNoTerminalTabs(page);
      await openWorkspaceScriptsMenu(page);
      await startWorkspaceScriptFromMenu(page, "web");
      await closeWorkspaceScriptsMenu(page);
      await clickFirstTerminalTab(page);
      await expectTerminalSurfaceVisible(page, { timeout: 10_000 });
      await waitForTerminalAttached(page);
      await expectFirstTerminalTabContains(page, "web");
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("launches workspace scripts through an explicit daemon request", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-scripts-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo bootstrapping; sleep 1; echo setup complete'"],
        },
        scripts: {
          editor: {
            command: "node -e \"console.log('editor ready'); setInterval(() => {}, 1000)\"",
          },
        },
      },
    });

    try {
      await seedProjectForWorkspaceSetup(client, repo.path);
      const completed = waitForWorkspaceSetupProgress(
        client,
        (payload) =>
          payload.status === "completed" && payload.detail.log.includes("setup complete"),
      );

      const result = await client.createPaseoWorktree({
        cwd: repo.path,
        worktreeSlug: "workspace-setup-scripts",
      });
      if (!result.workspace) {
        throw new Error(result.error ?? "Failed to create workspace");
      }
      const workspaceDir = result.workspace.workspaceDirectory;
      const workspaceId = result.workspace.id;

      await completed;

      const scriptClient = client as typeof client & WorkspaceScriptStarter;
      const startResult = await scriptClient.startWorkspaceScript(workspaceId, "editor");
      expect(startResult).toMatchObject({
        workspaceId,
        scriptName: "editor",
        terminalId: expect.any(String),
        error: null,
      });

      const findEditorTerminal = (terminal: { name: string }) => terminal.name === "editor";
      await expect
        .poll(async () => {
          const terminals = await client.listTerminals(workspaceDir);
          return terminals.terminals.find(findEditorTerminal) ?? null;
        })
        .toMatchObject({
          id: expect.any(String),
          name: "editor",
        });
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });
});
