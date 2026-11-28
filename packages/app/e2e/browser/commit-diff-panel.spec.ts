import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { ElementHandle, Locator, Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openChangesTreePanel } from "../support/helpers/workspace-tabs";

const COMMIT_SUBJECT = "Show commit timestamps";

test("long workspace history scrolls without crowding out changed files", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "commit-history-scroll-" });
  await createLongHistory(workspace.repoPath);
  await Promise.all(
    Array.from({ length: 50 }, (_, index) =>
      writeFile(
        path.join(workspace.repoPath, `dirty-${String(index).padStart(2, "0")}.txt`),
        "change\n",
      ),
    ),
  );
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  const panel = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const header = panel.getByTestId("commits-section-header");
  await header.click();
  const rows = panel.locator('[data-testid^="commit-row-"]');
  await expect(rows).toHaveCount(100);

  const commitScroll = await scrollOwner(rows.first());
  const fileScroll = await scrollOwner(panel.getByTestId("changes-file-tree"));
  expect(await commitScroll.evaluate((element) => element.scrollHeight)).toBeGreaterThan(
    await commitScroll.evaluate((element) => element.clientHeight),
  );
  const headerBefore = await header.boundingBox();
  const filesBefore = await fileScroll.evaluate((element) => element.scrollTop);
  await wheelDown(page, commitScroll, 300);
  await wheelToBottom(page, commitScroll);
  await expect(rows.last()).toBeInViewport();
  expect(await header.boundingBox()).toEqual(headerBefore);
  expect(await fileScroll.evaluate((element) => element.scrollTop)).toBe(filesBefore);
  await expect(header).toBeInViewport();

  const commitsBefore = await commitScroll.evaluate((element) => element.scrollTop);
  await wheelToBottom(page, fileScroll);
  await expect(panel.getByText("dirty-49.txt", { exact: true })).toBeInViewport();
  expect(await commitScroll.evaluate((element) => element.scrollTop)).toBe(commitsBefore);
  await expectNoPanelOverflow(panel);
  await page.screenshot({ path: test.info().outputPath("commits-and-changed-files.png") });

  const sidebarWidth = await panel.evaluate((element) => element.getBoundingClientRect().width);
  const resizeHandle = page
    .getByTestId("workspace-explorer-sidebar-resize-handle")
    .getByRole("separator");
  const handleBox = await resizeHandle.boundingBox();
  if (!handleBox) throw new Error("Explorer sidebar resize handle has no bounds");
  const handleX = handleBox.x + handleBox.width / 2;
  const handleY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX - 100, handleY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => panel.evaluate((element) => element.getBoundingClientRect().width))
    .toBeGreaterThan(sidebarWidth + 50);
  await expect(rows.last()).toBeInViewport();
  await expectNoPanelOverflow(panel);

  await header.click();
  await expect(rows).toHaveCount(0);
  await header.click();
  await expect(rows).toHaveCount(100);
  await page.setViewportSize({ width: 1100, height: 320 });
  const resizedScroll = await scrollOwner(rows.first());
  await wheelToBottom(page, resizedScroll);
  await expect(rows.last()).toBeInViewport();
  await expect(header).toBeInViewport();
  await expectNoPanelOverflow(panel);
  await rows.last().click();
  const diff = page.getByTestId("commit-diff-panel").filter({ visible: true });
  await expect(diff.getByTestId("git-diff-canvas")).toBeVisible();
  await expect(diff.getByTestId("diff-file-0")).toHaveAccessibleName("feature.txt, +2, -0");
});

test("long workspace history remains reachable without changed files", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "commit-history-clean-" });
  await createLongHistory(workspace.repoPath);
  await page.setViewportSize({ width: 1400, height: 320 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  const panel = page.getByTestId("changes-tree-panel").filter({ visible: true });
  await panel.getByRole("button", { name: "Diff mode", exact: true }).click();
  await page.getByTestId("changes-diff-mode-uncommitted").click();
  await expect(panel.getByTestId("changes-file-tree")).toHaveCount(0);
  const header = panel.getByTestId("commits-section-header");
  await header.click();
  const rows = panel.locator('[data-testid^="commit-row-"]');
  await expect(rows).toHaveCount(100);
  const scroll = await scrollOwner(rows.first());
  await wheelToBottom(page, scroll);
  await expect(rows.last()).toBeInViewport();
  await expect(header).toBeInViewport();
  await expectNoPanelOverflow(panel);
  await rows.last().click();
  const diff = page.getByTestId("commit-diff-panel").filter({ visible: true });
  await expect(diff.getByTestId("diff-file-0")).toHaveAccessibleName("feature.txt, +2, -0");
});

test("short workspace history keeps its natural height with no changed files", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "commit-history-short-" });
  await createFeatureCommit(workspace.repoPath);
  for (let index = 1; index < 5; index++) {
    execFileSync("git", ["commit", "--allow-empty", "-m", `Workspace commit ${index}`], {
      cwd: workspace.repoPath,
      stdio: "ignore",
    });
  }
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  const panel = page.getByTestId("changes-tree-panel").filter({ visible: true });
  const header = panel.getByTestId("commits-section-header");
  await header.click();
  const rows = panel.locator('[data-testid^="commit-row-"]');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toBeInViewport();
  await expect(rows.last()).toBeInViewport();
  const sectionHeight = await header.evaluate((element) => element.parentElement!.clientHeight);
  const panelHeight = await panel.evaluate((element) => element.clientHeight);
  expect(sectionHeight).toBeLessThan(panelHeight / 2);
  await rows.last().click();
  await expect(page.getByTestId("commit-diff-panel").filter({ visible: true })).toBeVisible();
});

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

test("a fresh commit says just now and its age advances", async ({ page, withWorkspace }) => {
  const workspace = await withWorkspace({ prefix: "commit-relative-time-" });
  const committedAt = new Date();
  await createFeatureCommit(workspace.repoPath, committedAt.toISOString());
  await page.clock.install({ time: committedAt });
  await workspace.navigateTo();

  await openChangesTreePanel(page);
  await page.getByRole("button", { name: /Commits/i }).click();
  const row = page.locator('[data-testid^="commit-row-"]').filter({ hasText: COMMIT_SUBJECT });
  await expect(row).toContainText("just now", { timeout: 30_000 });
  await page.clock.fastForward("03:00");
  await expect(row).toContainText("3m ago");
});

async function createFeatureCommit(
  repoPath: string,
  authorDate = "2020-01-15T12:00:00Z",
): Promise<void> {
  execFileSync("git", ["checkout", "-b", "feature"], { cwd: repoPath, stdio: "ignore" });
  await writeFile(path.join(repoPath, "feature.txt"), "before\nafter\n");
  execFileSync("git", ["add", "feature.txt"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", COMMIT_SUBJECT], {
    cwd: repoPath,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_DATE: authorDate,
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

async function createLongHistory(repoPath: string) {
  await createFeatureCommit(repoPath);
  for (let index = 1; index < 100; index++) {
    execFileSync("git", ["commit", "--allow-empty", "-m", `Workspace commit ${index}`], {
      cwd: repoPath,
      stdio: "ignore",
    });
  }
}

/** Find the nearest scroll viewport, never a different scrolling ancestor. */
async function scrollOwner(content: Locator): Promise<ElementHandle<HTMLElement>> {
  return content.evaluateHandle((element) => {
    let owner: HTMLElement | null =
      element instanceof HTMLElement ? element : element.parentElement;
    while (owner) {
      if (/^(auto|scroll)$/.test(getComputedStyle(owner).overflowY)) return owner;
      owner = owner.parentElement;
    }
    throw new Error("Content has no vertical scroll owner");
  });
}

async function wheelDown(page: Page, owner: ElementHandle<HTMLElement>, delta: number) {
  const box = await owner.boundingBox();
  if (!box || box.height <= 0) throw new Error("Scroll viewport has no visible bounds");
  const before = await owner.evaluate((element) => element.scrollTop);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, delta);
  await expect.poll(() => owner.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
}

async function wheelToBottom(page: Page, owner: ElementHandle<HTMLElement>) {
  const remaining = await owner.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
  if (remaining > 1) await wheelDown(page, owner, remaining);
  await expect
    .poll(() =>
      owner.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(1);
}

async function expectNoPanelOverflow(panel: Locator) {
  expect(
    await panel.evaluate((element) => {
      const overflow = [];
      for (
        let ancestor: HTMLElement | null = element as HTMLElement;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        if (ancestor.scrollHeight > ancestor.clientHeight + 1)
          overflow.push(ancestor.dataset.testid ?? ancestor.tagName);
      }
      return overflow;
    }),
  ).toEqual([]);
}
