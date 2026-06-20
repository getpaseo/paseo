import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { createIdleAgent, expectSessionRowArchived, openSessions } from "./helpers/archive-tab";
import { restartTestDaemon } from "./helpers/daemon-restart";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { connectSeedClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

test.describe("Worktree restore after daemon restart", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();
  const createdProjectIds = new Set<string>();

  test.describe.configure({ retries: 0, timeout: 180_000 });

  test.beforeEach(async () => {
    client = await connectSeedClient();
    worktreeClient = await connectNewWorkspaceDaemonClient();
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
  });

  test("after archiving a worktree and restarting the daemon, History shows the worktree branch (not main) before any restore", async ({
    page,
  }) => {
    const serverId = getServerId();

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

    // Bounce the isolated test daemon on the SAME home and port so it rebuilds
    // all workspace/agent links from persisted state. Then reconnect both clients.
    await client.close().catch(() => undefined);
    await worktreeClient.close().catch(() => undefined);
    await restartTestDaemon();
    client = await connectSeedClient();
    worktreeClient = await connectNewWorkspaceDaemonClient();

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
