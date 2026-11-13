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

function terminalSurface(page: Page): Locator {
  return page.getByTestId("terminal-surface").filter({ visible: true }).first();
}

function visibleComposer(page: Page): Locator {
  return page.getByTestId("message-input-root").locator("textarea:visible").first();
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

async function openEmptyAgentComposer(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+A");
  await expect(visibleComposer(page)).toBeFocused();
}

async function openAgentComposerWithDraft(page: Page, draftText: string): Promise<Locator> {
  await page.keyboard.press("Meta+Shift+A");
  const composer = visibleComposer(page);
  await expect(composer).toBeVisible();
  await composer.click();
  await composer.fill(draftText);
  return composer;
}

async function openTerminalTab(page: Page): Promise<void> {
  await page.getByTestId("workspace-new-tab-button").filter({ visible: true }).first().click();
  await page
    .getByTestId("workspace-new-tab-menu-terminal")
    .filter({ visible: true })
    .first()
    .click();
  await expect(terminalSurface(page)).toBeVisible({ timeout: 30_000 });
}

async function expectArrowShortcutsPassThroughToDraftComposer(
  page: Page,
  expectedText: string,
): Promise<void> {
  const composer = visibleComposer(page);
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.evaluate((element) => {
    const prevented: boolean[] = [];
    (element as HTMLElement & { __arrowDefaultPrevented?: boolean[] }).__arrowDefaultPrevented =
      prevented;
    element.addEventListener("keydown", (event) => {
      if (
        event instanceof KeyboardEvent &&
        event.metaKey &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        prevented.push(event.defaultPrevented);
      }
    });
  });
  await page.keyboard.press("Meta+ArrowLeft");
  await page.keyboard.press("Meta+ArrowRight");
  const prevented = await composer.evaluate(
    (element) =>
      (element as HTMLElement & { __arrowDefaultPrevented?: boolean[] }).__arrowDefaultPrevented ??
      [],
  );
  expect(prevented).toEqual([false, false]);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue(expectedText);
  await expect(previewFrame(page)).toHaveCount(0);
  await expect(diffPanel(page)).toHaveCount(0);
}

async function pressArrowAndExpectPanel(options: {
  page: Page;
  shortcut: "Meta+ArrowLeft" | "Meta+ArrowRight";
  expectedPanel: Locator;
}): Promise<void> {
  await options.page.keyboard.press(options.shortcut);
  await expect(options.expectedPanel).toBeVisible();
}

test("cycles continuously through Agent, Diff, Preview, and Terminal tabs with Meta+ArrowLeft/Right without getting trapped by auto-focus", async ({
  page,
  withWorkspace,
}) => {
  const workspace = await withWorkspace({ prefix: "mac-tab-arrows-" });
  await seedModifiedReadme(workspace.repoPath);
  await workspace.navigateTo();

  // Tab order created in the workspace:
  // [0] Empty Draft Agent (auto-focused on creation and on Cmd+1)
  // [1] Changes Diff
  // [2] README.md Markdown Preview
  // [3] Draft Agent with unsent text ("draft message")
  // [4] Terminal
  await openEmptyAgentComposer(page);
  await openChangesDiffTab(page);
  await openReadmePreviewTab(page);
  await openAgentComposerWithDraft(page, "draft message");
  await openTerminalTab(page);

  // Switch explicitly to Tab [0] via Alt+Shift+1 (web jump-to-tab): its empty composer
  // auto-focuses, yet Meta+ArrowRight must still advance to Tab [1] without manual blur.
  await page.keyboard.press("Alt+Shift+Digit1");
  await expect(visibleComposer(page)).toBeFocused();
  await expect(visibleComposer(page)).toHaveValue("");

  await pressArrowAndExpectPanel({
    page,
    shortcut: "Meta+ArrowRight",
    expectedPanel: diffPanel(page),
  });
  await pressArrowAndExpectPanel({
    page,
    shortcut: "Meta+ArrowRight",
    expectedPanel: previewFrame(page),
  });

  // Landing on Tab [3] (Agent tab with non-empty draft) via Meta+ArrowRight must NOT
  // auto-focus the composer, so pressing Meta+ArrowRight again continues to Tab [4].
  await page.keyboard.press("Meta+ArrowRight");
  await expect(visibleComposer(page)).toHaveValue("draft message");
  await expect(visibleComposer(page)).not.toBeFocused();

  // Landing on Tab [4] (Terminal) via Meta+ArrowRight must NOT auto-focus xterm,
  // so pressing Meta+ArrowRight again wraps back to Tab [0] and then Tab [1].
  await pressArrowAndExpectPanel({
    page,
    shortcut: "Meta+ArrowRight",
    expectedPanel: terminalSurface(page),
  });
  await pressArrowAndExpectPanel({
    page,
    shortcut: "Meta+ArrowRight",
    expectedPanel: visibleComposer(page),
  });
  await expect(visibleComposer(page)).toHaveValue("");
  await expect(visibleComposer(page)).not.toBeFocused();

  // Reverse cycling with Meta+ArrowLeft also passes cleanly through Terminal and Draft Agent.
  await pressArrowAndExpectPanel({
    page,
    shortcut: "Meta+ArrowLeft",
    expectedPanel: terminalSurface(page),
  });
  await page.keyboard.press("Meta+ArrowLeft");
  await expect(visibleComposer(page)).toHaveValue("draft message");
  await expect(visibleComposer(page)).not.toBeFocused();

  // Once the user explicitly clicks into the non-empty composer, Meta+ArrowLeft/Right
  // pass through without preventDefault instead of switching tabs.
  await expectArrowShortcutsPassThroughToDraftComposer(page, "draft message");
});
