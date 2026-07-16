import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";

const CHANGES_PREFERENCES_KEY = "@paseo:changes-preferences";
const COMMIT_SUBJECT = "Show commit timestamps";

test("commit history shows dates and shares diff layout preferences", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "commit-diff-panel-" });
  await createFeatureCommit(workspace.repoPath);
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();

  await page.getByRole("button", { name: "Open explorer" }).click();
  await expect(page.getByTestId("commits-section-header")).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("commits-section-header").click();

  const commitRow = page.locator('[data-testid^="commit-row-"]').filter({
    hasText: COMMIT_SUBJECT,
  });
  await expect(commitRow).toContainText(COMMIT_SUBJECT, { timeout: 30_000 });
  await expect(commitRow).toContainText("Jan 15");
  await commitRow.click();

  const panel = page.getByTestId("commit-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("commit-diff-toolbar")).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByTestId("commit-diff-layout-unified")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(panel.getByTestId("diff-code-row-0")).toBeVisible({ timeout: 30_000 });

  await panel.getByTestId("commit-diff-layout-split").click();
  await expect(panel.getByTestId("commit-diff-layout-split")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expectStoredLayout(page, "split");
  await expect(panel.getByTestId("diff-code-row-0")).toHaveCount(0);
  await expect(panel.getByTestId("diff-file-0-body")).toBeVisible();

  await page.setViewportSize({ width: 480, height: 900 });
  await expect(panel.getByTestId("commit-diff-toolbar")).toHaveCount(0);
  await expect(panel.getByTestId("diff-code-row-0")).toBeVisible();
});

async function createFeatureCommit(repoPath: string): Promise<void> {
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoPath, stdio: "ignore" });
  await writeFile(path.join(repoPath, "feature.txt"), "before\nafter\n");
  execFileSync("git", ["add", "feature.txt"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", COMMIT_SUBJECT], {
    cwd: repoPath,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2020-01-15T12:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-15T12:00:00Z",
    },
  });
}

async function expectStoredLayout(page: Page, layout: "unified" | "split"): Promise<void> {
  await expect
    .poll(async () => {
      const stored = await page.evaluate(
        (key) => localStorage.getItem(key),
        CHANGES_PREFERENCES_KEY,
      );
      if (!stored) {
        return null;
      }
      return (JSON.parse(stored) as { layout?: string }).layout ?? null;
    })
    .toBe(layout);
}
