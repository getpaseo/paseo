import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { composerLocator } from "./composer";
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

export async function reportSkippedLargeFiles(page: Page, workspace: CreatedWorkspace) {
  // rg never opens a file above the host ceiling, so an unqualified "No matches" would claim the
  // whole workspace was read.
  await writeFile(path.join(workspace.repoPath, "large.txt"), `needle${" ".repeat(1024 * 1024)}`);
  await workspace.navigateTo();
  await page.keyboard.press("Meta+Shift+F");
  const input = page.getByRole("textbox", { name: "Search saved file contents...", exact: true });
  await input.fill("needle");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel.getByText("No matches", { exact: true })).toBeVisible();
  await expect(
    panel.getByText("Files over 1.0 MB were not searched", { exact: true }),
  ).toBeVisible();
  // The occurrence-cap notice is a different claim and must not appear here.
  await expect(panel.getByText(/Results limited/)).toHaveCount(0);
}

export async function openLiteralBackslashFile(page: Page, workspace: CreatedWorkspace) {
  // A backslash is an ordinary character in a Unix file name; "a\b.txt" is not "a/b.txt".
  await writeFile(path.join(workspace.repoPath, "a\\b.txt"), "needle LITERAL FILE");
  await mkdir(path.join(workspace.repoPath, "a"), { recursive: true });
  await writeFile(path.join(workspace.repoPath, "a", "b.txt"), "THIS IS THE OTHER FILE");
  await workspace.navigateTo();
  await page.keyboard.press("Meta+Shift+F");
  await page
    .getByRole("textbox", { name: "Search saved file contents...", exact: true })
    .fill("needle");
  const panel = page.getByTestId("command-center-panel");
  await expect(panel.getByRole("button", { name: /a\\b\.txt:1:1/ })).toBeVisible();
  await expect(panel.getByTestId("file-source-editor")).toContainText("LITERAL FILE");
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
  const source = page.getByTestId("file-source-editor");
  await expect(source).toContainText("LITERAL FILE");
  await expect(source).not.toContainText("THIS IS THE OTHER FILE");
  await expect(page.getByRole("status").filter({ hasText: "File changed" })).toHaveCount(0);
}

/**
 * Opening the same occurrence twice has to navigate the pane both times. The tab target is
 * deliberately identity-stable, so the second activation looks like a no-op unless it asks the
 * file-opening owner to navigate again.
 */
export async function reopenSameOccurrenceAfterMovingAway(page: Page, workspace: CreatedWorkspace) {
  const lines = Array.from(
    { length: 1200 },
    (_value, index) => `export const filler${index} = ${index};`,
  );
  lines.push('const marker = "REOPEN_TARGET";');
  await writeFile(path.join(workspace.repoPath, "reopen.ts"), `${lines.join("\n")}\n`);
  await workspace.navigateTo();

  const scroller = page.getByTestId("file-source-editor").locator(".cm-scroller");
  const offset = () => scroller.evaluate((element) => element.scrollTop);

  await openReopenTarget(page);
  const revealed = await offset();
  expect(revealed).toBeGreaterThan(0);
  await expect(
    page.getByTestId("file-source-editor").locator(".cm-selectionBackground"),
  ).toBeInViewport();

  // Move the caret to the top of the same file, inside the same editor instance.
  await page.getByTestId("file-source-editor").locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+Home");
  await expect.poll(offset).toBeLessThan(revealed / 2);

  await openReopenTarget(page);
  await expect
    .poll(offset, { message: "reopening the same occurrence must navigate the pane again" })
    .toBeGreaterThan(revealed / 2);
  await expect(
    page.getByTestId("file-source-editor").locator(".cm-selectionBackground"),
  ).toBeInViewport();
  // The editor instance is reused, so its history survives the second navigation.
  await expect(page.getByTestId("file-source-editor")).toContainText("REOPEN_TARGET");
}

async function openReopenTarget(page: Page) {
  await page.keyboard.press("Meta+Shift+F");
  const panel = page.getByTestId("command-center-panel");
  await page
    .getByRole("textbox", { name: "Search saved file contents...", exact: true })
    .fill("REOPEN_TARGET");
  await expect(panel.getByRole("button", { name: /reopen\.ts:1201:/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(panel).toBeHidden();
}

/**
 * Two files can share a base name and their nearest parent, and a real path is often wider than
 * the result column, so the exact workspace-relative path lives in the tooltip. Being in the DOM
 * is not enough: the tooltip has to be the thing painted at its own coordinates.
 */
export async function revealExactPathOnHover(page: Page, workspace: CreatedWorkspace) {
  const deep =
    "packages/app/src/command-center/workspace-content-search/internal/deeply/nested/result-path-presentation.ts";
  for (const relative of [
    "packages/app/src/utils/index.ts",
    "packages/server/src/utils/index.ts",
    deep,
  ]) {
    const target = path.join(workspace.repoPath, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `export const shared = "SHARED_UTIL";\n`);
  }
  await workspace.navigateTo();
  await page.keyboard.press("Meta+Shift+F");
  await page
    .getByRole("textbox", { name: "Search saved file contents...", exact: true })
    .fill("SHARED_UTIL");

  const panel = page.getByTestId("command-center-panel");
  const rows = panel.getByRole("button", { name: /:1:24/ });
  await expect(rows).toHaveCount(3);
  const tip = page.getByTestId("content-search-row-path");

  async function expectPaintedPath(row: Locator, expected: string) {
    await row.hover();
    await expect(tip).toHaveText(expected);
    // The reader must actually see it: whatever is painted at the tooltip's own coordinates has
    // to be the tooltip, not the panel that used to cover it.
    // A tooltip is pointer-transparent, so elementFromPoint reports the row underneath either
    // way, and its surface is the same white as the panel. What settles it is whether the pixels
    // in its own rectangle change when it opens: if the panel still covers it, they do not.
    const box = await tip.boundingBox();
    if (!box) throw new Error("tooltip has no box");
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
    const shown = await page.screenshot({ clip });
    await page.mouse.move(2, 2);
    await expect(tip).toBeHidden();
    const hidden = await page.screenshot({ clip });
    expect(
      shown.equals(hidden),
      "the tooltip's own rectangle must change when it opens, or the reader cannot see it",
    ).toBe(false);
  }

  // Same base name and same nearest parent: the resting labels cannot tell these apart.
  const app = rows.filter({ hasText: "…/utils/index.ts:1:24" }).first();
  const server = rows.filter({ hasText: "…/utils/index.ts:1:24" }).last();
  await expect(app).toHaveAccessibleName(/^packages\/app\/src\/utils\/index\.ts:1:24 /);
  await expect(server).toHaveAccessibleName(/^packages\/server\/src\/utils\/index\.ts:1:24 /);
  await expectPaintedPath(app, "packages/app/src/utils/index.ts:1:24");
  await expectPaintedPath(server, "packages/server/src/utils/index.ts:1:24");

  // A path far wider than the result column still reads in full.
  await expectPaintedPath(
    rows.filter({ hasText: "result-path-presentation.ts" }).first(),
    `${deep}:1:24`,
  );
  return { panel, rows, tip };
}

/**
 * The overlay chrome the desktop panel owns: a backdrop that dismisses it, Escape that dismisses
 * it, and focus that goes back where it came from. Hosting the panel in the shared overlay root
 * rather than a native Modal must not change any of it.
 */
export async function keepDesktopOverlayChrome(page: Page, workspace: CreatedWorkspace) {
  await writeFile(path.join(workspace.repoPath, "chrome.ts"), 'const a = "CHROME_TARGET";\n');
  await workspace.navigateTo();
  const panel = page.getByTestId("command-center-panel");
  const input = page.getByRole("textbox", { name: "Search saved file contents...", exact: true });

  // Backdrop dismisses the panel.
  const composer = composerLocator(page);
  await composer.click();
  await expect(composer).toBeFocused();
  await page.keyboard.press("Meta+Shift+F");
  await expect(input).toBeFocused();
  await page.mouse.click(page.viewportSize()!.width - 12, page.viewportSize()!.height - 12);
  await expect(panel).toBeHidden();

  // Escape dismisses it and hands focus back to the composer it was opened from.
  await page.keyboard.press("Meta+Shift+F");
  await input.fill("CHROME_TARGET");
  await expect(panel.getByRole("button", { name: /chrome\.ts:1:/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(composer).toBeFocused();

  // Ordinary commands and the Files scope still open over the same chrome.
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("command-center-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+p");
  await expect(page.getByRole("textbox", { name: "Search files...", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
}
