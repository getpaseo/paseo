import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openChangesTreePanel } from "../support/helpers/workspace-tabs";

const COMMIT_SUBJECT = "Add old.txt";
const COMMIT_DIFF_FILE = "old.txt, +1, -0";
// Enough later commits to push the one under test past the base history the
// commits list keeps.
const LATER_COMMITS = 12;

test.describe.configure({ timeout: 240_000 });

test("an open commit diff survives its commit leaving the commits list", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "commit-diff-aged-out-" });
  const repoPath = workspace.repoPath;
  git(repoPath, ["checkout", "-b", "feature"]);
  await commit(repoPath, "old.txt", "old\n", COMMIT_SUBJECT);

  try {
    await page.setViewportSize({ width: 1400, height: 900 });
    await gotoWorkspace(page, workspace.workspaceId);
    const changes = await openCommitDiffFromCommitsSection(page);
    await expectCommitDiff(page);

    for (let index = 1; index <= LATER_COMMITS; index += 1) {
      await commit(repoPath, `later-${index}.txt`, `${index}\n`, `Later ${index}`);
    }
    // Base catches up, so the commit is now deep in base history and the commits
    // list stops carrying it.
    git(repoPath, ["branch", "-f", "main", "feature"]);
    await changes.getByTestId("changes-refresh").click();
    await expect(changes.getByTestId("commits-section-no-workspace-commits")).toBeVisible({
      timeout: 30_000,
    });

    await expectCommitDiff(page);
  } finally {
    await workspace.cleanup();
  }
});

function git(repoPath: string, args: string[]): void {
  execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
}

async function commit(
  repoPath: string,
  file: string,
  content: string,
  subject: string,
): Promise<void> {
  await writeFile(path.join(repoPath, file), content);
  git(repoPath, ["add", file]);
  git(repoPath, ["commit", "-m", subject]);
}

/** Opens the Commits section, selects the commit under test, returns the Changes panel. */
async function openCommitDiffFromCommitsSection(page: Page): Promise<Locator> {
  await openChangesTreePanel(page);
  const changes = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const commitsSection = changes.getByRole("button", { name: /Commits/i });
  await expect(commitsSection).toBeVisible({ timeout: 30_000 });
  await commitsSection.click();
  await changes.locator('[data-testid^="commit-row-"]').filter({ hasText: COMMIT_SUBJECT }).click();
  return changes;
}

async function expectCommitDiff(page: Page): Promise<void> {
  const panel = page.getByTestId("commit-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName(COMMIT_DIFF_FILE, {
    timeout: 30_000,
  });
}
