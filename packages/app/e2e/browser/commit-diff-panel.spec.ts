import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openChangesTreePanel } from "../support/helpers/workspace-tabs";

const COMMIT_SUBJECT = "Show commit timestamps";

test("commit history explains when the workspace has no commits ahead of its base", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "commit-history-empty-workspace-" });
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: workspace.repoPath, stdio: "ignore" });
  await workspace.navigateTo();

  await openChangesTreePanel(page);
  const commitsSection = page.getByRole("button", { name: /Commits/i });
  await expect(commitsSection).toBeVisible({ timeout: 30_000 });
  await commitsSection.click();

  await expect(page.getByTestId("commits-section-no-workspace-commits")).toHaveText(
    "No commits ahead of main yet",
    { timeout: 30_000 },
  );
});

test("commit history shows dates and shares diff layout preferences", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "commit-diff-panel-" });
  await createFeatureCommit(workspace.repoPath);
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();

  await openChangesTreePanel(page);
  const commitsSection = page.getByRole("button", { name: /Commits/i });
  await expect(commitsSection).toBeVisible({ timeout: 30_000 });
  await commitsSection.click();

  const commitRow = page.locator('[data-testid^="commit-row-"]').filter({
    hasText: COMMIT_SUBJECT,
  });
  await expect(commitRow).toContainText(COMMIT_SUBJECT, { timeout: 30_000 });
  await expect(page.locator('[data-testid^="commit-row-"]')).toHaveCount(1);
  await expect(commitRow).toContainText("Jan 15");
  await commitRow.click();

  const panel = page.getByTestId("commit-diff-panel").filter({ visible: true });
  await expect(panel.getByTestId("commit-diff-toolbar")).toBeVisible({ timeout: 30_000 });
  const layoutToggle = panel.getByTestId("commit-diff-toggle-layout");
  const [commitToolbarBox, layoutToggleBox, layoutToggleGlyphBox] = await Promise.all([
    panel.getByTestId("commit-diff-header").boundingBox(),
    layoutToggle.boundingBox(),
    layoutToggle.locator("svg").boundingBox(),
  ]);
  if (!commitToolbarBox || !layoutToggleBox || !layoutToggleGlyphBox) {
    throw new Error("Commit-diff toolbar geometry could not be measured");
  }
  expect(commitToolbarBox.height).toBe(36);
  expect(layoutToggleBox.width).toBe(20);
  expect(layoutToggleBox.height).toBe(20);
  expect(layoutToggleGlyphBox.width).toBe(14);
  expect(layoutToggleGlyphBox.height).toBe(14);
  await expect(layoutToggle).toHaveAccessibleName("Switch to side-by-side diff");
  await expect(panel.getByTestId("git-diff-canvas")).toBeVisible({ timeout: 30_000 });
  await expectCommitDiffHeaderGeometry(panel);

  await layoutToggle.click();
  await expect(layoutToggle).toHaveAccessibleName("Switch to unified diff");
  await expect(panel.locator('[data-testid^="diff-code-row-"]')).toHaveCount(0);
  await expect(panel.getByTestId("diff-file-0-body")).toBeVisible();

  await page.getByTestId(/^workspace-tab-commit_diff_/).hover();
  await page.getByTestId(/^workspace-commit-diff-close-/).click();
  await expect(panel).toHaveCount(0);
  await commitRow.click();
  await expect(panel.getByTestId("commit-diff-toggle-layout")).toHaveAccessibleName(
    "Switch to unified diff",
    { timeout: 30_000 },
  );

  await page.setViewportSize({ width: 480, height: 900 });
  await expect(panel.getByTestId("commit-diff-toolbar")).toHaveCount(0);
  await expect(panel.getByTestId("git-diff-canvas")).toBeVisible();
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

async function expectCommitDiffHeaderGeometry(panel: Locator): Promise<void> {
  const [header, canvas] = await Promise.all([
    panel.getByTestId("diff-file-0").boundingBox(),
    panel.getByTestId("git-diff-sticky-header-0").boundingBox(),
  ]);
  expect(header).not.toBeNull();
  expect(canvas).not.toBeNull();
  expect(header!.height).toBeCloseTo(30, 0);
  expect(header!.x).toBeCloseTo(canvas!.x, 0);
  expect(header!.width).toBeCloseTo(canvas!.width, 0);
  expect(header!.y).toBeCloseTo(canvas!.y, 0);
  await expect(panel.getByTestId("diff-file-0")).toHaveAccessibleName("feature.txt, +2, -0");
}
