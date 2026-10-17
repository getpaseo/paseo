import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import {
  openFileExplorer,
  openFileFromExplorer,
  expectFileTabOpen,
} from "../support/helpers/file-explorer";
import { gotoWorkspace } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";

const FILE_NAME = "note.md";
const MARKDOWN = [
  "# Sample Title",
  "",
  "first beta tail here",
  "",
  "**bold** middle tail phrase",
  "",
  "last beta line",
].join("\n");

let workspace: SeededWorkspace;

test.beforeEach(async () => {
  workspace = await seedWorkspace({ repoPrefix: "file-preview-find-" });
  await writeFile(path.join(workspace.workspaceDirectory, FILE_NAME), MARKDOWN);
});

test.afterEach(async () => {
  await workspace?.cleanup();
});

function filePane(page: Page) {
  return page.getByTestId("workspace-file-pane").filter({ visible: true }).last();
}
function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}
function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}
function marks(page: Page) {
  return filePane(page).locator("mark.paseo-file-find-hit");
}

async function openMarkdownPreview(page: Page) {
  await gotoWorkspace(page, workspace.workspaceId);
  await openFileExplorer(page);
  await openFileFromExplorer(page, FILE_NAME);
  await expectFileTabOpen(page, FILE_NAME);
  // The rendered preview, not Source mode, must own the content.
  await expect(filePane(page).getByText("middle tail phrase", { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await filePane(page).click();
}

test("Cmd+F searches the rendered markdown preview", async ({ page }) => {
  await openMarkdownPreview(page);

  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();

  await query(page).fill("beta");
  await expect(status(page)).toHaveText("1 of 2");
  await expect(marks(page)).toHaveCount(2);

  // Enter cycles to the next match and wraps around.
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("2 of 2");
  await expect(marks(page).nth(1)).toHaveClass(/paseo-file-find-hit-current/);
  await page.keyboard.press("Enter");
  await expect(status(page)).toHaveText("1 of 2");
  await expect(marks(page).nth(0)).toHaveClass(/paseo-file-find-hit-current/);

  // Escape closes the bar and restores the plain text DOM.
  await page.keyboard.press("Escape");
  await expect(query(page)).toHaveCount(0);
  await expect(marks(page)).toHaveCount(0);
});

test("matches phrases across inline formatting, not across blocks", async ({ page }) => {
  await openMarkdownPreview(page);

  await page.keyboard.press("ControlOrMeta+f");
  await query(page).fill("bold middle");
  // "bold" lives in <strong> and " middle" in the sibling text node: one
  // logical match rendered as two adjacent marks.
  await expect(status(page)).toHaveText("1 of 1");
  await expect(marks(page)).toHaveCount(2);

  // Text split by a paragraph boundary must not match.
  await query(page).fill("here bold");
  await expect(status(page)).toHaveText("No matches");
});

test("re-highlights when the preview content changes under an open search", async ({ page }) => {
  await openMarkdownPreview(page);

  await page.keyboard.press("ControlOrMeta+f");
  await query(page).fill("gamma");
  await expect(status(page)).toHaveText("No matches");

  await writeFile(
    path.join(workspace.workspaceDirectory, FILE_NAME),
    `${MARKDOWN}\n\ntailing gamma line`,
  );
  await expect(filePane(page).getByText("tailing gamma line")).toBeVisible({ timeout: 30_000 });
  await expect(status(page)).toHaveText("1 of 1");
});
