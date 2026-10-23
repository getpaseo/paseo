import { appendFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import { openChangesTreePanel } from "../support/helpers/workspace-tabs";

function changesTree(page: Page) {
  return page.getByTestId("changes-tree-panel").filter({ visible: true });
}

async function expectEmptyChanges(page: Page) {
  await expect(changesTree(page).getByText("No changes to display", { exact: true })).toBeVisible();
}

async function editReadme(repoPath: string, text: string) {
  await appendFile(path.join(repoPath, "README.md"), text);
}

async function expectReadmeChanges(page: Page, additions: number) {
  await expect(changesTree(page).getByText("README.md", { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(changesTree(page)).toContainText(`+${additions}`);
}

async function openEmptyDiff(page: Page) {
  await changesTree(page).getByTestId("changes-options-menu").click();
  await page.getByTestId("changes-open-tab").click();
  await expect(
    page
      .getByTestId("working-diff-panel")
      .filter({ visible: true })
      .getByText("No changes to display", { exact: true }),
  ).toBeVisible();
}

async function expectReadmeDiff(page: Page, additions: number) {
  await expect(
    page.getByTestId("working-diff-panel").filter({ visible: true }).getByTestId("diff-file-0"),
  ).toHaveAccessibleName(`README.md, +${additions}, -0`, { timeout: 30_000 });
}

async function openDiffFromNewTabMenu(page: Page) {
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page.getByTestId("workspace-new-tab-menu-diff").filter({ visible: true }).first().click();
  await expect(
    page
      .getByTestId("working-diff-panel")
      .filter({ visible: true })
      .getByText("No changes to display", { exact: true }),
  ).toBeVisible();
}

async function refreshDiff(page: Page) {
  await page
    .getByTestId("working-diff-panel")
    .filter({ visible: true })
    .getByTestId("changes-refresh")
    .click();
}

async function reloadWorkspace(page: Page) {
  await page.reload();
}

test("Changes follows the first edit to a clean workspace without reloading", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  await expectEmptyChanges(page);

  await editReadme(workspace.repoPath, "first edit\n");
  await expectReadmeChanges(page, 1);

  await editReadme(workspace.repoPath, "second edit\n");
  await expectReadmeChanges(page, 2);
});

test("the full diff follows the first edit to a clean workspace without reloading", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openChangesTreePanel(page);
  await expectEmptyChanges(page);
  await openEmptyDiff(page);

  await editReadme(workspace.repoPath, "first edit\n");
  await expectReadmeDiff(page, 1);

  await editReadme(workspace.repoPath, "second edit\n");
  await expectReadmeDiff(page, 2);
});

test("a directly opened Diff tab follows the first edit without an active Changes tree", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace();
  await page.setViewportSize({ width: 1400, height: 900 });
  await workspace.navigateTo();
  await openDiffFromNewTabMenu(page);

  await editReadme(workspace.repoPath, "first edit\n");
  await expectReadmeDiff(page, 1);

  await editReadme(workspace.repoPath, "second edit\n");
  await expectReadmeDiff(page, 2);

  await refreshDiff(page);
  await expectReadmeDiff(page, 2);
  await reloadWorkspace(page);
  await expectReadmeDiff(page, 2);
  await editReadme(workspace.repoPath, "third edit\n");
  await expectReadmeDiff(page, 3);
});
