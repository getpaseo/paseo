import { unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { CreatedWorkspace } from "./with-workspace";

export async function prepareContentSearch(workspace: CreatedWorkspace) {
  await writeFile(
    path.join(workspace.repoPath, "search-a.ts"),
    'export const greeting = "NEEDLE";\n',
  );
  await writeFile(
    path.join(workspace.repoPath, "search-b.ts"),
    'const emoji = "é🙂 needle needle";\n',
  );
  await workspace.navigateTo();
}
export async function searchContents(page: Page, query: string) {
  await page.keyboard.press("Meta+Shift+F");
  const input = page.getByRole("textbox", { name: "Search saved file contents...", exact: true });
  await expect(input).toBeVisible();
  await input.fill(query);
  await expect(page.getByRole("button", { name: /search-a.ts:1:26/ })).toBeVisible();
}
export async function previewAndOpenSecondOccurrence(page: Page, screenshot: string) {
  const panel = page.getByTestId("command-center-panel");
  const input = page.getByRole("textbox", { name: "Search saved file contents...", exact: true });
  await expect(panel.getByTestId("file-source-editor")).toContainText("export const greeting");
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByTestId("file-source-editor")).toContainText("const emoji");
  await expect(input).toBeFocused();
  // The query field is the Command Center's own header input, above the results and preview.
  const inputBox = await input.boundingBox();
  const previewBox = await panel.getByTestId("file-source-editor").boundingBox();
  expect(inputBox!.y + inputBox!.height).toBeLessThan(previewBox!.y);
  await panel.screenshot({ path: screenshot });
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  await expect(page.getByTestId("file-source-editor")).toContainText("const emoji");
  // The source view uses a real CodeMirror document; select-all is unnecessary and would hide a bad jump.
  await expect(page.getByLabel("Line 1, column 26", { exact: true })).toBeVisible();
}
export async function openCompactPreview(page: Page, screenshot: string) {
  await page.getByRole("button", { name: /search-a.ts:1:26/ }).click();
  await expect(page.getByRole("button", { name: "Back to results", exact: true })).toBeVisible();
  await expect(
    page.getByTestId("command-center-panel").getByTestId("file-source-editor"),
  ).toContainText("export const greeting");
  await page.getByTestId("command-center-panel").screenshot({ path: screenshot });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByTestId("command-center-panel")).toBeHidden();
  await expect(page.getByTestId("file-source-editor")).toContainText("export const greeting");
}

export async function preserveDirtyBufferAndUndo(page: Page, workspace: CreatedWorkspace) {
  const source = page.getByTestId("file-source-editor").locator(".cm-content");
  await source.fill("const localUnsaved = 42;\n");
  await writeFile(
    path.join(workspace.repoPath, "search-b.ts"),
    'const emoji = "é🙂 needle needle";\n// changed on disk\n',
  );
  await expect(page.getByTestId("file-conflict-alert")).toBeVisible();
  await searchContents(page, "needle");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByTestId("command-center-panel").getByTestId("file-source-editor"),
  ).toContainText("changed on disk");
  await page.keyboard.press("Enter");
  await expect(source).toContainText("localUnsaved");
  await expect(page.getByRole("status").filter({ hasText: "File changed" })).toContainText(
    "saved match is no longer at this location",
  );
  await source.press("Control+z");
  await expect(source).toContainText('const emoji = "é🙂 needle needle";');
  await expect(source).not.toContainText("localUnsaved");
}

export async function recoverChangedAndMissingPreview(
  page: Page,
  workspace: CreatedWorkspace,
  screenshot: string,
) {
  const panel = page.getByTestId("command-center-panel");
  const input = page.getByRole("textbox", { name: "Search saved file contents...", exact: true });
  await writeFile(path.join(workspace.repoPath, "search-b.ts"), "changed after search\n");
  await page.keyboard.press("ArrowDown");
  await expect(panel.getByRole("status")).toContainText(
    "saved match is no longer at this location",
  );
  await unlink(path.join(workspace.repoPath, "search-a.ts"));
  await page.keyboard.press("ArrowUp");
  await expect(panel.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await writeFile(
    path.join(workspace.repoPath, "search-a.ts"),
    'export const greeting = "NEEDLE";\n',
  );
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(panel.getByTestId("file-source-editor")).toContainText("NEEDLE");
  await input.fill("not-present-anywhere");
  await expect(panel.getByText("No matches", { exact: true })).toBeVisible();
  await writeFile(path.join(workspace.repoPath, "many.txt"), "needle\n".repeat(250));
  await input.fill("needle");
  await expect(panel.getByText(/Results limited/)).toBeVisible();
  await panel.screenshot({ path: screenshot });
}

export async function searchContentsByTouch(page: Page, query: string) {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page
    .getByRole("textbox", {
      name: "Search commands, files, workspaces, and agents...",
      exact: true,
    })
    .fill("Search file contents");
  await page.getByText("Search file contents", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Search saved file contents...", exact: true })
    .fill(query);
  await expect(page.getByRole("button", { name: /search-a.ts:1:26/ })).toBeVisible();
}

export async function openLiteralSourceOccurrence(
  page: Page,
  workspace: CreatedWorkspace,
  input: { path: string; content: string; result: string; cursor?: string; imageFirst?: boolean },
  screenshot: string,
) {
  await writeFile(path.join(workspace.repoPath, input.path), input.content);
  await writeFile(path.join(workspace.repoPath, "leading.txt"), "different file");
  await workspace.navigateTo();
  if (input.imageFirst) {
    await page.keyboard.press("Meta+p");
    await page.getByRole("textbox", { name: "Search files...", exact: true }).fill(input.path);
    await page.getByTestId("command-center-panel").getByText(input.path, { exact: true }).click();
    await expect(page.getByTestId("image-file-preview")).toBeVisible();
  }
  await page.keyboard.press("Meta+Shift+F");
  await page
    .getByRole("textbox", { name: "Search saved file contents...", exact: true })
    .fill("needle");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel.getByRole("button", { name: input.result, exact: true })).toBeVisible();
  await expect(panel.getByTestId("file-source-editor")).toContainText("needle");
  await expect(panel.getByRole("status").filter({ hasText: "File changed" })).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  const source = page.getByTestId("file-source-editor");
  await expect(source).toContainText("needle");
  await expect(source).not.toContainText("different file");
  await expect(source.locator(".cm-selectionBackground")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "File changed" })).toHaveCount(0);
  if (input.cursor) await expect(page.getByLabel(input.cursor, { exact: true })).toBeVisible();
  await page.screenshot({ path: screenshot });
}
