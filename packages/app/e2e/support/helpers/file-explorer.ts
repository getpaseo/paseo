import { expect, type Download, type Page } from "@playwright/test";
import { openFilesPanel } from "./workspace-tabs";

function fileExplorerTree(page: Page) {
  return page.getByTestId("file-explorer-tree-scroll");
}

function fileExplorerEntry(page: Page, name: string) {
  return fileExplorerTree(page).getByText(name, { exact: true }).first();
}

export async function openFileExplorer(page: Page): Promise<void> {
  await openFilesPanel(page);
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

export async function downloadFileFromExplorer(page: Page, fileName: string): Promise<Download> {
  await fileExplorerEntry(page, fileName).click({ button: "right" });
  const downloaded = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Download", exact: true }).click();
  return downloaded;
}

export async function downloadFileFromPreview(page: Page): Promise<Download> {
  await expect(page.getByText("Binary preview unavailable", { exact: true })).toBeVisible();
  const button = page.getByRole("button", { name: "Download", exact: true });
  await expect(button).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await button.click();
  return downloaded;
}

export async function openExplorerContextMenu(page: Page, name: string): Promise<void> {
  await fileExplorerEntry(page, name).click({ button: "right" });
}

/**
 * Playwright cannot answer the File System Access folder picker, so this resolves it with the
 * page's origin-private file system: a real directory handle the app writes through. Call before
 * the page loads.
 */
export async function answerFolderPickerWithOriginStorage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: () => navigator.storage.getDirectory(),
    });
  });
}

/** Removes the folder picker, as in Firefox and Safari. Call before the page loads. */
export async function removeFolderPicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    delete (Window.prototype as { showDirectoryPicker?: unknown }).showDirectoryPicker;
    delete (window as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
}

/** Everything in the origin-private file system: folders end with `/`, files map to base64. */
export async function readOriginStorage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    interface Handle {
      kind: "file" | "directory";
      name: string;
      getFile(): Promise<File>;
      values(): AsyncIterable<Handle>;
    }
    const result: Record<string, string> = {};
    const walk = async (directory: Handle, prefix: string) => {
      for await (const handle of directory.values()) {
        if (handle.kind === "directory") {
          result[`${prefix}${handle.name}/`] = "";
          await walk(handle, `${prefix}${handle.name}/`);
          continue;
        }
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        result[`${prefix}${handle.name}`] = btoa(binary);
      }
    };
    await walk((await navigator.storage.getDirectory()) as unknown as Handle, "");
    return result;
  });
}
