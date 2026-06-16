import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Dialog, Page } from "@playwright/test";
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

// The archive confirmation is a synchronous web `window.confirm()`. The click that
// opens it does not resolve until the dialog is answered, so the handler must
// accept/dismiss inline — awaiting the dialog only *after* the click deadlocks, as
// the click waits for an answer that is gated behind that same click.
async function clickArchiveAndAnswerWarning(
  page: Page,
  workspaceId: string,
  answer: "accept" | "dismiss",
): Promise<Dialog> {
  let warning: Dialog | undefined;
  page.once("dialog", (dialog) => {
    warning = dialog;
    void (answer === "accept" ? dialog.accept() : dialog.dismiss());
  });
  await clickArchiveWorkspaceMenuItem(page, workspaceId);
  if (!warning) {
    throw new Error("Expected an archive confirmation dialog, but none was shown.");
  }
  return warning;
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

    const firstWarning = await clickArchiveAndAnswerWarning(page, worktree.workspaceId, "dismiss");
    expect(firstWarning.type()).toBe("confirm");
    expect(firstWarning.message()).toContain(`Archive "${worktree.workspaceName}"?`);
    expect(firstWarning.message()).toContain("Uncommitted changes");
    expect(firstWarning.message()).toContain("1 unpushed commit");

    await expect(
      page.getByTestId(`sidebar-workspace-row-${serverId}:${worktree.workspaceId}`),
    ).toBeVisible({ timeout: 10_000 });
    expect(existsSync(worktree.workspaceDirectory)).toBe(true);

    const secondWarning = await clickArchiveAndAnswerWarning(page, worktree.workspaceId, "accept");
    expect(secondWarning.message()).toContain("Uncommitted changes");
    expect(secondWarning.message()).toContain("1 unpushed commit");

    await expectWorkspaceAbsentFromSidebar(page, worktree.workspaceId);
    await expect
      .poll(() => existsSync(worktree.workspaceDirectory), { timeout: 30_000 })
      .toBe(false);

    createdWorktreeDirectories.delete(worktree.workspaceDirectory);
  });
});
