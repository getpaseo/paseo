import { test, expect } from "./fixtures";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForWorkspaceTabsVisible } from "./helpers/workspace-tabs";
import { waitForTerminalContent } from "./helpers/terminal-perf";
import {
  connectWorkspaceSetupClient,
  createWorkspaceThroughDaemon,
  expectSetupPanel,
  openHomeWithProject,
  seedProjectForWorkspaceSetup,
  waitForWorkspaceSetupProgress,
} from "./helpers/workspace-setup";

function getServerId(): string {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set.");
  }
  return serverId;
}

/** Click the sidebar row for a workspace (by ID) and wait for navigation. */
async function navigateToWorkspaceViaSidebar(
  page: import("@playwright/test").Page,
  workspaceId: string,
): Promise<void> {
  const testId = `sidebar-workspace-row-${getServerId()}:${workspaceId}`;
  const row = page.getByTestId(testId);
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });
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

      // Navigate to workspace and verify it's usable
      await openHomeWithProject(page, repo.path);
      await navigateToWorkspaceViaSidebar(page, workspace.id);

      await waitForWorkspaceTabsVisible(page);
      await page.getByTestId("workspace-new-agent-tab").first().click();
      await expect(page.getByRole("textbox", { name: "Message agent..." }).first()).toBeVisible({
        timeout: 30_000,
      });

      const explorerToggle = page.getByTestId("workspace-explorer-toggle").first();
      if ((await explorerToggle.getAttribute("aria-label")) === "Open explorer") {
        await explorerToggle.click();
      }
      await expect(explorerToggle).toHaveAttribute("aria-label", "Close explorer", {
        timeout: 30_000,
      });
      await page.getByTestId("explorer-tab-files").click();
      await expect(page.getByTestId("file-explorer-tree-scroll")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("README.md", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("src", { exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
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

  test("launches script terminals after setup completes", async ({ page }) => {
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

      // Wait for the script terminal tab to appear in the tabs bar.
      // The tab title shows the command, not the script name.
      const terminalTab = page.locator('[data-testid^="workspace-tab-terminal_"]').first();
      await expect(terminalTab).toBeVisible({ timeout: 30_000 });

      // Click the script terminal tab
      await terminalTab.click();

      // Verify the terminal surface rendered
      const terminalSurface = page.getByTestId("terminal-surface").first();
      await expect(terminalSurface).toBeVisible({ timeout: 10_000 });

      // Wait for terminal to fully attach (loading overlay gone)
      await page
        .locator('[data-testid="terminal-attach-loading"]')
        .waitFor({ state: "hidden", timeout: 10_000 })
        .catch(() => {
          // overlay may never appear if attachment is instant
        });

      await terminalSurface.click();

      // Verify the terminal output contains "listening on" via xterm buffer API.
      // The .xterm-rows CSS selector is fragile; reading the buffer directly is reliable.
      await waitForTerminalContent(page, (text) => text.includes("listening on"), 60_000);
    } finally {
      await client.close();
      await repo.cleanup();
    }
  });

  test("launches workspace scripts after setup completes", async () => {
    const client = await connectWorkspaceSetupClient();
    const repo = await createTempGitRepo("setup-scripts-", {
      paseoConfig: {
        worktree: {
          setup: ["sh -c 'echo bootstrapping; sleep 1; echo setup complete'"],
        },
        scripts: {
          editor: {
            command: "npm run dev",
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

      await completed;

      await expect
        .poll(async () => {
          const terminals = await client.listTerminals(workspaceDir);
          return terminals.terminals.find((terminal) => terminal.name === "editor") ?? null;
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
