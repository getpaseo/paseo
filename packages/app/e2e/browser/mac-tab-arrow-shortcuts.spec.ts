import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

function diffPanel(page: Page) {
  return page.getByTestId("working-diff-panel").filter({ visible: true });
}

function previewFrame(page: Page) {
  return page.getByTestId("markdown-preview-frame").filter({ visible: true });
}

async function openChangesDiffTab(page: Page) {
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page.getByTestId("workspace-new-tab-menu-diff").filter({ visible: true }).first().click();
  await expect(diffPanel(page)).toBeVisible();
}

test("switches top workspace tabs with Meta+ArrowLeft/Right outside inputs while preserving editable caret behavior", async ({
  page,
  withWorkspace,
}, testInfo) => {
  const workspace = await withWorkspace({ prefix: "mac-tab-arrows-" });
  await writeFile(
    path.join(workspace.repoPath, "README.md"),
    "# Mac Tab Arrow Demo\nUpdated line\n",
  );
  await workspace.navigateTo();

  // Tab 1: Changes Diff
  await openChangesDiffTab(page);
  await expect(diffPanel(page).getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });

  // Tab 2: README.md Markdown preview
  await openFileExplorer(page);
  await openFileFromExplorer(page, "README.md");
  await expect(previewFrame(page)).toBeVisible();

  // Tab 3: New Agent tab (with editable message input)
  await page.keyboard.press("Meta+Shift+A");
  const composer = page.locator("textarea:visible").first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill("draft message");

  // While composer is focused, Meta+ArrowLeft/Right must stay inside the editable field and NOT switch tabs
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.press("Meta+ArrowRight");
  await expect(composer).toBeFocused();
  await expect(previewFrame(page)).toHaveCount(0);
  await expect(diffPanel(page)).toHaveCount(0);

  // Once focus leaves the editable input, Meta+ArrowLeft/Right switches top workspace tabs
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });

  await page.keyboard.press("Meta+ArrowLeft");
  await expect(previewFrame(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mac-tab-arrow-left-to-markdown.png") });

  await page.keyboard.press("Meta+ArrowLeft");
  await expect(diffPanel(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mac-tab-arrow-left-to-diff.png") });

  await page.keyboard.press("Meta+ArrowRight");
  await expect(previewFrame(page)).toBeVisible();
});
