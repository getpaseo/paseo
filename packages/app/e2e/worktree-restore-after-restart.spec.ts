import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { gotoAppShell } from "./helpers/app";
import { createIdleAgent, expectSessionRowArchived, openSessions } from "./helpers/archive-tab";
import { buildCreateAgentPreferences, buildSeededHost } from "./helpers/daemon-registry";
import { startIsolatedHostDaemon, type IsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { connectSeedClient } from "./helpers/seed-client";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

test.describe("Worktree restore after daemon restart", () => {
  const serverId = `srv_worktree_restart_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let daemon: IsolatedHostDaemon;
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();
  const createdProjectIds = new Set<string>();

  test.describe.configure({ retries: 0, timeout: 180_000 });

  test.beforeEach(async () => {
    daemon = await startIsolatedHostDaemon(serverId);
    client = await connectSeedClient({ port: daemon.port });
    worktreeClient = await connectNewWorkspaceDaemonClient({ port: daemon.port });
    tempRepo = await createTempGitRepo("wt-restart-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(worktreeClient, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    for (const projectId of createdProjectIds) {
      await worktreeClient.removeProject(projectId).catch(() => undefined);
    }
    createdProjectIds.clear();
    await client?.close().catch(() => undefined);
    await worktreeClient?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
    await daemon?.close().catch(() => undefined);
  });

  async function seedBrowser(page: Page) {
    const nowIso = new Date().toISOString();
    await page.addInitScript(
      ({ host, preferences }) => {
        localStorage.setItem("@paseo:e2e", "1");
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([host]));
        localStorage.removeItem("@paseo:settings");
        localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
      },
      {
        host: buildSeededHost({
          serverId,
          endpoint: `127.0.0.1:${daemon.port}`,
          label: "restart daemon",
          nowIso,
        }),
        preferences: buildCreateAgentPreferences(serverId),
      },
    );
  }

  test("after archiving a worktree and restarting the daemon, History shows the worktree branch (not main) before any restore", async ({
    page,
  }) => {
    // A paseo worktree is cut on its own branch named after the slug, and the
    // worktree workspace is displayed under the same name. These are the values
    // the History table cells must show after restore — never "main".
    const worktreeSlug = `restart-restore-${randomUUID().slice(0, 8)}`;

    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: worktreeSlug,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `restart-restore-${randomUUID().slice(0, 8)}`,
    });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    // Archive through the default production path (no scope): the worktree dir is deleted.
    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    // Restart this spec's daemon on the same home and port so it rebuilds all
    // workspace/agent links from persisted state without replacing the shared
    // Playwright daemon owned by global setup.
    await client.close().catch(() => undefined);
    await worktreeClient.close().catch(() => undefined);
    await daemon.restart();
    client = await connectSeedClient({ port: daemon.port });
    worktreeClient = await connectNewWorkspaceDaemonClient({ port: daemon.port });

    await seedBrowser(page);
    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await expectSessionRowArchived(page, agent.title);

    // KEY ASSERTION: reproduce the screenshot state. Right after the daemon
    // restart, with NO restore and NO row click, the rendered History table cells
    // (fed by each agent row's projectPlacement via fetch_agent_history) must read
    // the worktree branch and the worktree workspace name — never "main".
    const branchCell = page.getByTestId(`agent-row-branch-${serverId}-${agent.id}`);
    const workspaceCell = page.getByTestId(`agent-row-workspace-${serverId}-${agent.id}`);

    await expect(branchCell).toBeVisible({ timeout: 60_000 });
    await expect(branchCell).toHaveText(worktreeSlug, { timeout: 60_000 });
    await expect(workspaceCell).toHaveText(worktree.workspaceName, { timeout: 60_000 });
  });
});
