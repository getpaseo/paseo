import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "./fixtures";
import { expectFileTabOpen, openFileExplorer, openFileFromExplorer } from "./helpers/file-explorer";
import type { WithWorkspace } from "./helpers/with-workspace";
import { installDaemonWebSocketGate } from "./helpers/daemon-websocket-gate";

function visibleEditor(page: Page) {
  return page.getByTestId("file-source-editor").filter({ visible: true }).locator(".cm-content");
}

function filePane(page: Page) {
  return page.getByTestId("workspace-file-pane").filter({ visible: true });
}

function fileCallout(page: Page) {
  return filePane(page).getByRole("alert");
}

async function openFile(page: Page, filename: string): Promise<void> {
  await openFileExplorer(page);
  await openFileFromExplorer(page, filename);
  await expectFileTabOpen(page, filename);
}

async function openTrackedFile(
  page: Page,
  withWorkspace: WithWorkspace,
  input: { prefix: string; relativePath: string; content: string },
): Promise<string> {
  const workspace = await withWorkspace({ prefix: input.prefix });
  const filePath = path.join(workspace.repoPath, input.relativePath);
  await writeFile(filePath, input.content, "utf8");
  await workspace.navigateTo();
  await openFile(page, input.relativePath);
  return filePath;
}

async function replaceEditorText(page: Page, content: string): Promise<void> {
  const editor = visibleEditor(page);
  await editor.click();
  await editor.press("Control+A");
  await editor.type(content);
}

async function replaceFileAfterDeletionWasObserved(input: {
  page: Page;
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>;
  filePath: string;
  relativePath: string;
  content: string;
}): Promise<void> {
  const { page, gate, filePath, relativePath, content } = input;
  // Recreate the observed race without faking file state: the daemon publishes the
  // deletion, then a real read succeeds after the replacement while its ready event waits.
  await gate.waitForFileSubscription(relativePath);
  gate.holdFileReads(relativePath);
  await unlink(filePath);
  await gate.waitForHeldFileRead();
  await expectOnlyFileCallout(page, "File deleted on disk");
  gate.holdNextReadyFileUpdate(relativePath);
  await writeFile(filePath, content, "utf8");
  gate.releaseHeldFileRead();
  await gate.waitForHeldReadyFileUpdate();
  await expect.poll(() => readFile(filePath, "utf8")).toBe(content);
}

async function expectOnlyFileCallout(page: Page, title: string): Promise<void> {
  await expect(fileCallout(page)).toHaveCount(1);
  await expect(fileCallout(page)).toContainText(title);
  await expect(filePane(page).getByText(title, { exact: true })).toHaveCount(1);
}

async function expectCleanReplacementCanReload(page: Page): Promise<void> {
  await expectOnlyFileCallout(page, "Changed on disk");
  await expect(filePane(page).getByText("File deleted on disk", { exact: true })).toHaveCount(0);
  await expect(fileCallout(page).getByRole("button", { name: "Overwrite" })).toHaveCount(0);
  await expect(fileCallout(page).getByRole("button", { name: "Reload" })).toBeEnabled();
  await fileCallout(page).getByRole("button", { name: "Reload" }).click();
  await expect(filePane(page).getByText("After", { exact: true })).toBeVisible();
  await expect(fileCallout(page)).toHaveCount(0);
}

async function expectDeletedFileNotice(page: Page): Promise<void> {
  await expectOnlyFileCallout(page, "File deleted on disk");
  await expect(fileCallout(page)).toContainText("The open copy is preserved.");
  await expect(filePane(page).getByText("Changed on disk", { exact: true })).toHaveCount(0);
  await expect(fileCallout(page).getByRole("button", { name: "Overwrite" })).toHaveCount(0);
  await expect(fileCallout(page).getByRole("button", { name: "Reload" })).toHaveCount(0);
}

async function expectDirtyConflictCanReload(page: Page): Promise<void> {
  await expectOnlyFileCallout(page, "Changed on disk");
  await expect(fileCallout(page).getByRole("button", { name: "Overwrite" })).toBeEnabled();
  await expect(fileCallout(page).getByRole("button", { name: "Reload" })).toBeEnabled();
  page.once("dialog", (dialog) => dialog.accept());
  await fileCallout(page).getByRole("button", { name: "Reload" }).click();
  await expect(visibleEditor(page)).toContainText("const external = true;");
  await expect(fileCallout(page)).toHaveCount(0);
}

test.describe("Workspace file change conflicts", () => {
  test("a clean file replaced on disk offers one working reload action", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-clean-replacement-",
      relativePath: "inventory.md",
      content: "# Before\n",
    });
    await expect(filePane(page).getByText("Before", { exact: true })).toBeVisible();
    await replaceFileAfterDeletionWasObserved({
      page,
      gate,
      filePath,
      relativePath: "inventory.md",
      content: "# After\n",
    });
    await expectCleanReplacementCanReload(page);
    gate.releaseHeldReadyFileUpdate();
  });

  test("a deleted file shows one explanatory notice and no resolution actions", async ({
    page,
    withWorkspace,
  }) => {
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-deleted-",
      relativePath: "deleted.md",
      content: "# Present\n",
    });
    await expect(filePane(page).getByText("Present", { exact: true })).toBeVisible();
    await unlink(filePath);
    await expectDeletedFileNotice(page);
  });

  test("a changed file with local edits offers overwrite and a working reload", async ({
    page,
    withWorkspace,
  }) => {
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-dirty-conflict-",
      relativePath: "source.ts",
      content: "const before = true;\n",
    });
    await replaceEditorText(page, "const local = true;\n");
    await writeFile(filePath, "const external = true;\n", "utf8");
    await expectDirtyConflictCanReload(page);
  });
});
