import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  expectFileTabOpen,
  openFileExplorer,
  openFileFromExplorer,
} from "../support/helpers/file-explorer";
import type { WithWorkspace } from "../support/helpers/with-workspace";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  expectFileCalloutWasRendered,
  expectNoFileCalloutWasRendered,
  recordFileCallouts,
} from "../support/helpers/file-callouts";

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
  input: { prefix: string; relativePath: string; content: string | Uint8Array },
): Promise<string> {
  const workspace = await withWorkspace({ prefix: input.prefix });
  const filePath = path.join(workspace.repoPath, input.relativePath);
  if (typeof input.content === "string") {
    await writeFile(filePath, input.content, "utf8");
  } else {
    await writeFile(filePath, input.content);
  }
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
  await expect(fileCallout(page)).toHaveCount(0);
  gate.releaseHeldFileRead();
  await expectOnlyFileCallout(page, "File deleted on disk");
  gate.holdNextReadyFileUpdate(relativePath);
  await writeFile(filePath, content, "utf8");
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

async function restoreFileAfterWatcherObservedTemporaryAbsence(input: {
  gate: Awaited<ReturnType<typeof installDaemonWebSocketGate>>;
  filePath: string;
  relativePath: string;
}): Promise<void> {
  const parkedPath = `${input.filePath}.saving`;
  input.gate.holdFileReads(input.relativePath);
  await rename(input.filePath, parkedPath);
  await input.gate.waitForFileUpdate(input.relativePath, "missing");
  await input.gate.waitForHeldFileRead();
  await writeFile(input.filePath, await readFile(parkedPath));
  await unlink(parkedPath);
  input.gate.releaseHeldFileRead();
}

test.describe("Workspace file change conflicts", () => {
  test("a temporary write gap never renders a disk-change callout", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const relativePath = "temporary-gap.ts";
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-temporary-gap-",
      relativePath,
      content: "const preserved = true;\n",
    });
    await gate.waitForFileSubscription(relativePath);
    await recordFileCallouts(page);

    await restoreFileAfterWatcherObservedTemporaryAbsence({ gate, filePath, relativePath });
    await replaceEditorText(page, "const local = true;\n");

    await expect.poll(() => readFile(filePath, "utf8")).toContain("const local = true;");
    await expect(fileCallout(page)).toHaveCount(0);
    await expectNoFileCalloutWasRendered(page);
  });

  test("an identical atomic rewrite never renders a disk-change callout", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const relativePath = "identical-rewrite.ts";
    const content = "const preserved = true;\n";
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-identical-rewrite-",
      relativePath,
      content,
    });
    await gate.waitForFileSubscription(relativePath);
    await recordFileCallouts(page);

    gate.holdNextReadyFileUpdate(relativePath);
    await writeFile(`${filePath}.tmp`, content, "utf8");
    await rename(`${filePath}.tmp`, filePath);
    await gate.waitForHeldReadyFileUpdate();
    await replaceEditorText(page, "const local = true;\n");
    gate.releaseHeldReadyFileUpdate();

    await expect.poll(() => readFile(filePath, "utf8")).toContain("const local = true;");
    await expect(fileCallout(page)).toHaveCount(0);
    await expectNoFileCalloutWasRendered(page);
  });

  test("a save watcher refresh never replays the pre-save buffer", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const relativePath = "save-refresh.ts";
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-save-refresh-",
      relativePath,
      content: "const before = true;\n",
    });
    await gate.waitForFileSubscription(relativePath);
    await recordFileCallouts(page);
    gate.holdFileReads(relativePath);

    await replaceEditorText(page, "const saved = true;\n");
    await expect.poll(() => readFile(filePath, "utf8")).toContain("const saved = true;");
    await gate.waitForHeldFileRead();

    await expect(visibleEditor(page)).toContainText("const saved = true;");
    await expect(fileCallout(page)).toHaveCount(0);
    await expectNoFileCalloutWasRendered(page);
    gate.releaseHeldFileRead();
  });

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
    gate.releaseHeldReadyFileUpdate();
    await expectCleanReplacementCanReload(page);
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
    await recordFileCallouts(page);
    await unlink(filePath);
    await expectDeletedFileNotice(page);
    await expectFileCalloutWasRendered(page, "File deleted on disk");
  });

  test("a file check error offers a working retry", async ({ page, withWorkspace }) => {
    const gate = await installDaemonWebSocketGate(page);
    const relativePath = "retry.md";
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-check-retry-",
      relativePath,
      content: "# Before\n",
    });
    await gate.waitForFileSubscription(relativePath);
    await expect(filePane(page).getByText("Before", { exact: true })).toBeVisible();

    await unlink(filePath);
    await mkdir(filePath);
    await expectOnlyFileCallout(page, "Couldn't check file on disk");
    await expect(fileCallout(page).getByRole("button", { name: "Retry" })).toBeEnabled();
    await expect(fileCallout(page).getByRole("button", { name: "Reload" })).toHaveCount(0);
    await expect(fileCallout(page).getByRole("button", { name: "Overwrite" })).toHaveCount(0);

    gate.holdNextReadyFileUpdate(relativePath);
    await rm(filePath, { recursive: true });
    await writeFile(filePath, "# After\n", "utf8");
    await gate.waitForHeldReadyFileUpdate();
    gate.holdFileReads(relativePath);
    await fileCallout(page).getByRole("button", { name: "Retry" }).click();
    await gate.waitForHeldFileRead();
    await expect(fileCallout(page).getByRole("button", { name: "Retry" })).toBeDisabled();
    gate.releaseHeldFileRead();
    await expectCleanReplacementCanReload(page);
    gate.releaseHeldReadyFileUpdate();
  });

  test("retry clears a transient error when the file is unchanged", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const relativePath = "unchanged.md";
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-check-unchanged-",
      relativePath,
      content: "# Unchanged\n",
    });
    const parkedPath = `${filePath}.parked`;
    await gate.waitForFileSubscription(relativePath);
    await expect(filePane(page).getByText("Unchanged", { exact: true })).toBeVisible();

    await rename(filePath, parkedPath);
    await mkdir(filePath);
    await expectOnlyFileCallout(page, "Couldn't check file on disk");

    gate.holdNextReadyFileUpdate(relativePath);
    await rm(filePath, { recursive: true });
    await rename(parkedPath, filePath);
    await gate.waitForHeldReadyFileUpdate();
    await fileCallout(page).getByRole("button", { name: "Retry" }).click();

    await expect(fileCallout(page)).toHaveCount(0);
    await expect(filePane(page).getByText("Changed on disk", { exact: true })).toHaveCount(0);
    gate.releaseHeldReadyFileUpdate();
  });

  test("a read-only file error preserves its message and offers retry", async ({
    page,
    withWorkspace,
  }) => {
    const gate = await installDaemonWebSocketGate(page);
    const relativePath = "artifact.bin";
    const binaryContent = new Uint8Array([0, 1, 2, 3, 255]);
    const filePath = await openTrackedFile(page, withWorkspace, {
      prefix: "file-read-only-retry-",
      relativePath,
      content: binaryContent,
    });
    await gate.waitForFileSubscription(relativePath);
    await expect(
      filePane(page).getByText("Binary preview unavailable", { exact: true }),
    ).toBeVisible();

    await unlink(filePath);
    await mkdir(filePath);
    await expect(
      filePane(page).getByText("Requested path is not a file", { exact: true }),
    ).toBeVisible();
    await expect(filePane(page).getByRole("button", { name: "Retry" })).toBeEnabled();

    gate.holdNextReadyFileUpdate(relativePath);
    await rm(filePath, { recursive: true });
    await writeFile(filePath, binaryContent);
    await gate.waitForHeldReadyFileUpdate();
    gate.holdFileReads(relativePath);
    await filePane(page).getByRole("button", { name: "Retry" }).click();
    await gate.waitForHeldFileRead();
    await expect(
      filePane(page).getByText("Requested path is not a file", { exact: true }),
    ).toHaveCount(0);
    gate.releaseHeldFileRead();

    await expect(
      filePane(page).getByText("Binary preview unavailable", { exact: true }),
    ).toBeVisible();
    await expect(
      filePane(page).getByText("Requested path is not a file", { exact: true }),
    ).toHaveCount(0);
    gate.releaseHeldReadyFileUpdate();
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
