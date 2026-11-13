import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openFileExplorer, openFileFromExplorer } from "../support/helpers/file-explorer";

test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});

function diffPanel(page: Page): Locator {
  return page.getByTestId("working-diff-panel").filter({ visible: true });
}

function previewFrame(page: Page): Locator {
  return page.getByTestId("markdown-preview-frame").filter({ visible: true });
}

async function seedModifiedReadme(repoPath: string): Promise<void> {
  await writeFile(path.join(repoPath, "README.md"), "# Mac Tab Arrow Demo\nUpdated line\n");
}

async function openChangesDiffTab(page: Page): Promise<void> {
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page.getByTestId("workspace-new-tab-menu-diff").filter({ visible: true }).first().click();
  await expect(diffPanel(page).getByTestId("diff-file-0")).toBeVisible({ timeout: 30_000 });
}

async function openReadmePreviewTab(page: Page): Promise<void> {
  await openFileExplorer(page);
  await openFileFromExplorer(page, "README.md");
  await expect(previewFrame(page)).toBeVisible();
}

async function openAgentComposerWithDraft(page: Page, draftText: string): Promise<Locator> {
  await page.keyboard.press("Meta+Shift+A");
  const composer = page.locator("textarea:visible").first();
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill(draftText);
  return composer;
}

async function expectArrowShortcutsStayInComposer(page: Page, composer: Locator): Promise<void> {
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.press("Meta+ArrowRight");
  await expect(composer).toBeFocused();
  await expect(previewFrame(page)).toHaveCount(0);
  await expect(diffPanel(page)).toHaveCount(0);
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

async function switchTabWithArrowAndExpectVisible(
  page: Page,
  shortcut: "Meta+ArrowLeft" | "Meta+ArrowRight",
  expectedPanel: Locator,
): Promise<void> {
  await page.keyboard.press(shortcut);
  await expect(expectedPanel).toBeVisible();
}

test("switches top workspace tabs with Meta+ArrowLeft/Right outside inputs while preserving editable caret behavior", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "mac-tab-arrows-" });
  await seedModifiedReadme(workspace.repoPath);
  await workspace.navigateTo();

  await openChangesDiffTab(page);
  await openReadmePreviewTab(page);
  const composer = await openAgentComposerWithDraft(page, "draft message");

  await expectArrowShortcutsStayInComposer(page, composer);

  await blurActiveElement(page);
  await switchTabWithArrowAndExpectVisible(page, "Meta+ArrowLeft", previewFrame(page));
  await switchTabWithArrowAndExpectVisible(page, "Meta+ArrowLeft", diffPanel(page));
  await switchTabWithArrowAndExpectVisible(page, "Meta+ArrowRight", previewFrame(page));
});
