import { expect, type Page } from "@playwright/test";

function fileExplorerTree(page: Page) {
  return page.getByTestId("file-explorer-tree-scroll");
}

function fileExplorerEntry(page: Page, name: string) {
  return fileExplorerTree(page).getByText(name, { exact: true }).first();
}

export async function openFileExplorer(page: Page): Promise<void> {
  const openToggle = page.getByRole("button", { name: "Open explorer" }).first();
  if (await openToggle.isVisible().catch(() => false)) {
    await openToggle.click();
  }
  await expect(page.getByRole("button", { name: "Close explorer" }).first()).toBeVisible({
    timeout: 10_000,
  });

  const explorerPane = page
    .getByTestId("split-group-child")
    .filter({ has: page.getByTestId("workspace-tab-working_diff") })
    .filter({ visible: true })
    .first();
  const filesTab = explorerPane.getByTestId("workspace-tab-files");
  if ((await filesTab.count()) === 0) {
    await explorerPane.getByTestId("workspace-new-tab-menu-trigger").click();
    await page.getByTestId("workspace-new-tab-menu-files").filter({ visible: true }).click();
  }
  await filesTab.click();
  await expect(fileExplorerTree(page)).toBeVisible({ timeout: 30_000 });
}

export async function expandFolder(page: Page, folderName: string): Promise<void> {
  await fileExplorerEntry(page, folderName).click();
}

export async function collapseFolder(page: Page, folderName: string): Promise<void> {
  await fileExplorerEntry(page, folderName).click();
}

export async function openFileFromExplorer(page: Page, fileName: string): Promise<void> {
  await fileExplorerEntry(page, fileName).click();
}

export async function expectExplorerEntryVisible(page: Page, name: string): Promise<void> {
  await expect(fileExplorerEntry(page, name)).toBeVisible({ timeout: 30_000 });
}

export async function expectExplorerEntryHidden(page: Page, name: string): Promise<void> {
  await expect(fileExplorerEntry(page, name)).toBeHidden({ timeout: 30_000 });
}

export async function expectFileTabOpen(page: Page, filePath: string): Promise<void> {
  await expect(page.getByTestId(`workspace-tab-file_${filePath}`).first()).toBeVisible({
    timeout: 30_000,
  });
}
