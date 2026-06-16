import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "./helpers/new-workspace";
import { getServerId } from "./helpers/server-id";
import { clickArchiveWorkspaceMenuItem, expectWorkspaceAbsentFromSidebar } from "./helpers/sidebar";
import { createTempGitRepo } from "./helpers/workspace";
import { waitForSidebarHydration, waitForWorkspaceInSidebar } from "./helpers/workspace-ui";

async function seedRiskyWorktree(
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  worktreeDirectory: string,
): Promise<void> {
  const committedFile = path.join(worktreeDirectory, "UNPUSHED.md");
  await writeFile(committedFile, "# unpushed\n");
  execSync(`git add ${JSON.stringify(path.basename(committedFile))}`, {
    cwd: worktreeDirectory,
    stdio: "ignore",
  });
  execSync('git commit -m "Add unpushed change"', {
    cwd: worktreeDirectory,
    stdio: "ignore",
  });

  const dirtyFile = path.join(worktreeDirectory, "DIRTY.md");
  await writeFile(dirtyFile, "# dirty\n");

  const refreshed = await client.checkoutRefresh(worktreeDirectory);
  if (!refreshed.success) {
    throw new Error(`Failed to refresh checkout for ${worktreeDirectory}`);
  }
}

test.describe("Worktree archive risk warning", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-archive-risk-", { withRemote: true });
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  test("a risky worktree archive is gated by confirmation and removes the directory after acceptance", async ({
    page,
  }) => {
    const serverId = getServerId();
    await openProjectViaDaemon(client, tempRepo.path);
    const worktree = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `archive-risk-${Date.now()}`,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    await seedRiskyWorktree(client, worktree.workspaceDirectory);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: worktree.workspaceId });

    const dismissedDialog = page.waitForEvent("dialog");
    await clickArchiveWorkspaceMenuItem(page, worktree.workspaceId);
    const firstWarning = await dismissedDialog;
    expect(firstWarning.type()).toBe("confirm");
    expect(firstWarning.message()).toContain(`Archive "${worktree.workspaceName}"?`);
    expect(firstWarning.message()).toContain("Uncommitted changes");
    expect(firstWarning.message()).toContain("1 unpushed commit");
    await firstWarning.dismiss();

    await expect(
      page.getByTestId(`sidebar-workspace-row-${serverId}:${worktree.workspaceId}`),
    ).toBeVisible({ timeout: 10_000 });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    const acceptedDialog = page.waitForEvent("dialog");
    await clickArchiveWorkspaceMenuItem(page, worktree.workspaceId);
    const secondWarning = await acceptedDialog;
    expect(secondWarning.message()).toContain("Uncommitted changes");
    expect(secondWarning.message()).toContain("1 unpushed commit");
    await secondWarning.accept();

    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    createdWorktreeDirectories.delete(worktree.workspaceDirectory);
  });
});
