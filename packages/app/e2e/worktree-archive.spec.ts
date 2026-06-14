import { existsSync } from "node:fs";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { getServerId } from "./helpers/server-id";
import { archiveWorktreeFromSidebar, expectWorkspaceAbsentFromSidebar } from "./helpers/sidebar";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration, waitForWorkspaceInSidebar } from "./helpers/workspace-ui";

test.describe("Worktree archive", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-archive-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  test("archiving a worktree from the sidebar removes its row and worktree directory", async ({
    page,
  }) => {
    const serverId = getServerId();
    await openProjectViaDaemon(client, tempRepo.path);
    const worktree = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `archive-${Date.now()}`,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: worktree.workspaceId });

    await archiveWorktreeFromSidebar(page, worktree.workspaceId);

    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);
  });
});
