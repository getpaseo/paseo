import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveAgentFromDaemon,
  createIdleAgent,
  expectSessionRowArchived,
  fetchAgentArchivedAt,
  openSessions,
} from "./helpers/archive-tab";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { connectSeedClient } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration, waitForWorkspaceInSidebar } from "./helpers/workspace-ui";

test.describe("Worktree restore", () => {
  let client: Awaited<ReturnType<typeof connectSeedClient>>;
  let worktreeClient: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();
  const createdProjectIds = new Set<string>();

  test.describe.configure({ timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectSeedClient();
    worktreeClient = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-restore-");
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

  test("archiving an agent, then clicking it in History unarchives it in place (worktree dir untouched)", async ({
    page,
  }) => {
    const serverId = getServerId();
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `restore-inplace-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `restore-inplace-${randomUUID().slice(0, 8)}`,
    });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    await archiveAgentFromDaemon(client, agent.id);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await expectSessionRowArchived(page, agent.title);

    await page.getByTestId(`agent-row-${serverId}-${agent.id}`).click();

    await expect.poll(() => fetchAgentArchivedAt(client, agent.id), { timeout: 30_000 }).toBeNull();
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    // The History list is a cached react-query snapshot, so the cleared Archived
    // badge only renders after a cold refetch. Reload to remount the query fresh.
    await page.reload();
    await waitForSidebarHydration(page);
    await openSessions(page);
    const row = page
      .locator('[data-testid^="agent-row-"]')
      .filter({ hasText: agent.title })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).not.toContainText("Archived", { timeout: 30_000 });
  });

  test("archiving a worktree (dir deleted), then clicking its agent in History recreates the worktree", async ({
    page,
  }) => {
    const serverId = getServerId();
    const project = await openProjectViaDaemon(worktreeClient, tempRepo.path);
    createdProjectIds.add(project.projectKey);
    const worktree = await createWorktreeViaDaemon(worktreeClient, {
      cwd: tempRepo.path,
      slug: `restore-recreate-${randomUUID().slice(0, 8)}`,
    });
    createdProjectIds.add(worktree.projectKey);
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const agent = await createIdleAgent(client, {
      cwd: worktree.workspaceDirectory,
      workspaceId: worktree.workspaceId,
      title: `restore-recreate-${randomUUID().slice(0, 8)}`,
    });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    // Archive through the default production path the sidebar uses (no explicit
    // scope). With the restore prune fix, this default path frees the kept branch
    // so the daemon can re-check-out the worktree on restore.
    await archiveWorkspaceFromDaemon(worktreeClient, worktree.workspaceDirectory);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openSessions(page);
    await expectSessionRowArchived(page, agent.title);

    await page.getByTestId(`agent-row-${serverId}-${agent.id}`).click();

    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(true);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: worktree.workspaceId });
    await expect.poll(() => fetchAgentArchivedAt(client, agent.id), { timeout: 30_000 }).toBeNull();
  });
});
