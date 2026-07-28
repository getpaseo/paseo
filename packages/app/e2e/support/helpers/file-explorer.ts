import { expect, type Page } from "@playwright/test";

function fileExplorerTree(page: Page) {
  return page.getByTestId("file-explorer-tree-scroll");
}

function fileExplorerEntry(page: Page, name: string) {
  return fileExplorerTree(page).getByText(name, { exact: true }).first();
}

export async function openFileExplorer(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open explorer" }).first().click();
  await page.getByTestId("explorer-tab-files").click();
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
