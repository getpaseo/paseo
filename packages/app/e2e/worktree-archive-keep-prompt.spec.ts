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
import { expectWorkspaceAbsentFromSidebar, openWorktreeDeletePrompt } from "./helpers/sidebar";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration, waitForWorkspaceInSidebar } from "./helpers/workspace-ui";

// Model B: archiving the LAST reference to a Paseo-owned worktree opens the
// keep/delete prompt. Choosing "Keep on disk" archives the workspace record (the
// row disappears) but leaves the worktree directory on disk, because a directory
// can back multiple workspaces and archive removes the task, not the directory.
test.describe("Worktree archive keep prompt", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-archive-keep-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  test("keeping a last-reference worktree on disk removes the row but preserves the directory", async ({
    page,
  }) => {
    const serverId = getServerId();
    await openProjectViaDaemon(client, tempRepo.path);
    const worktree = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `archive-keep-${Date.now()}`,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: worktree.workspaceId });

    await openWorktreeDeletePrompt(page, worktree.workspaceId);
    await page.getByTestId("worktree-delete-confirm-keep").click();

    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);

    // The row is gone, but keeping on disk leaves the worktree directory in place
    // and the git worktree still registered with the repo.
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);
    const listed = await client.getPaseoWorktreeList({ cwd: tempRepo.path });
    expect(
      listed.worktrees.some((entry) => entry.worktreePath === worktree.workspaceDirectory),
    ).toBe(true);
  });
});
