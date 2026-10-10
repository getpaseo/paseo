import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { answerConfirmDialog } from "../support/helpers/confirm-dialog";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import {
  clickArchiveWorkspaceMenuItem,
  expectWorkspaceAbsentFromSidebar,
} from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

async function seedRiskyWorktree(
  client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>,
  worktreeDirectory: string,
): Promise<void> {
  // The daemon only reports unpushed commits when the branch has a configured
  // upstream (aheadOfOrigin is computed against `branch.<name>.merge`). Push the
  // worktree branch at its current head first so it tracks origin with 0 ahead,
  // then add the local commit below that becomes the single unpushed commit.
  const branch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: worktreeDirectory,
    stdio: "pipe",
  })
    .toString()
    .trim();
  execSync(`git push -u origin ${JSON.stringify(branch)}`, {
    cwd: worktreeDirectory,
    stdio: "ignore",
  });

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

// Returns the text of the in-app archive confirmation after answering it.
async function clickArchiveAndAnswerWarning(
  page: Page,
  workspaceId: string,
  answer: "accept" | "dismiss",
): Promise<string> {
  await clickArchiveWorkspaceMenuItem(page, workspaceId);
  return answerConfirmDialog(page, answer);
}

test.describe("Workspace archive risk warning for worktree backing", () => {
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

  test("a risky workspace archive is gated by confirmation and removes its worktree after acceptance", async ({
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

    const firstWarning = await clickArchiveAndAnswerWarning(page, worktree.workspaceId, "dismiss");
    expect(firstWarning).toContain(`Archive "${worktree.workspaceName}"?`);
    expect(firstWarning).toContain("Uncommitted changes");
    expect(firstWarning).toContain("1 unpushed commit");

    await expect(
      page.getByTestId(`sidebar-workspace-row-${serverId}:${worktree.workspaceId}`),
    ).toBeVisible({ timeout: 10_000 });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    const secondWarning = await clickArchiveAndAnswerWarning(page, worktree.workspaceId, "accept");
    expect(secondWarning).toContain("Uncommitted changes");
    expect(secondWarning).toContain("1 unpushed commit");

    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    createdWorktreeDirectories.delete(worktree.workspaceDirectory);
  });
});
